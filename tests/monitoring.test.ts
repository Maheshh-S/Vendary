import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the built-server Sentry bug: Next.js splits the
 * monitoring code across server graphs, so instrumentation's module instance
 * (which calls `initMonitoring`) is NOT the action chunk's instance (which
 * calls `captureException`). State must live on `globalThis`, and these tests
 * simulate the chunk split with `vi.resetModules()` + dynamic imports.
 */

const { initMock, captureExceptionMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  init: initMock,
  captureException: captureExceptionMock,
}));

const DSN = "https://public-key@sentry.example.com/42";
const originalDsn = process.env.SENTRY_DSN;

type SyntheticFrame = { filename?: string; vars?: Record<string, unknown> };
type SyntheticEvent = {
  request?: {
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    data?: Record<string, string>;
    query_string?: string;
  };
  user?: { email?: string };
  exception?: { values?: Array<{ stacktrace?: { frames?: SyntheticFrame[] } }> };
};

/** Imports a fresh module instance, as a separate server chunk would. */
const importMonitoring = async (): Promise<typeof import("@/lib/monitoring")> => {
  vi.resetModules();
  return import("@/lib/monitoring");
};

/** The instrumentation graph: the only graph that imports the SDK runtime. */
const importMonitoringInit = async (): Promise<typeof import("@/lib/monitoring-init")> => {
  vi.resetModules();
  return import("@/lib/monitoring-init");
};

const initOptions = (): { dataCollection?: Record<string, unknown>; beforeSend?: unknown } =>
  initMock.mock.calls.at(-1)?.[0] as {
    dataCollection?: Record<string, unknown>;
    beforeSend?: unknown;
  };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SENTRY_DSN;
  // Drop any global state left by another test file in the same worker.
  const scope = globalThis as {
    __vendarySentrySdk?: unknown;
    __vendarySentryEnabled?: boolean;
  };
  scope.__vendarySentrySdk = null;
  scope.__vendarySentryEnabled = false;
});

afterEach(() => {
  if (originalDsn === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = originalDsn;
  }
});

describe("monitoring without a DSN", () => {
  it("does not import or initialise the SDK and capture is a no-op", async () => {
    const monitoringInit = await importMonitoringInit();
    const monitoring = await importMonitoring();

    await expect(monitoringInit.initMonitoring()).resolves.toBe(false);
    expect(initMock).not.toHaveBeenCalled();

    expect(() =>
      monitoring.captureException(new Error("boom"), { action: "orders.place" })
    ).not.toThrow();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe("monitoring across server chunks", () => {
  it("captures from a module instance that never ran initMonitoring", async () => {
    process.env.SENTRY_DSN = DSN;

    // Chunk A (instrumentation): initialises and publishes the SDK.
    const instrumentationChunk = await importMonitoringInit();
    await expect(instrumentationChunk.initMonitoring()).resolves.toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);

    // Chunk B (a server action): imports `lib/monitoring` afresh. Its own
    // module-local state is empty; the process-global state must carry over.
    const actionChunk = await importMonitoring();

    actionChunk.captureException(new Error("action failed"), {
      action: "orders.place",
      requestId: "req_1",
      code: "INTERNAL",
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      tags: { action: "orders.place", requestId: "req_1", code: "INTERNAL" },
    });
  });

  it("initialises only once even when another chunk calls initMonitoring again", async () => {
    process.env.SENTRY_DSN = DSN;

    const first = await importMonitoringInit();
    await expect(first.initMonitoring()).resolves.toBe(true);

    const second = await importMonitoringInit();
    await expect(second.initMonitoring()).resolves.toBe(true);
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});

describe("monitoring PII opt-out", () => {
  it("disables stack-frame variable and DB query data collection", async () => {
    process.env.SENTRY_DSN = DSN;
    const monitoringInit = await importMonitoringInit();
    await monitoringInit.initMonitoring();

    expect(initOptions().dataCollection).toMatchObject({
      stackFrameVariables: false,
      databaseQueryData: false,
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    });
  });

  it("scrubs frame vars and request/user fields in beforeSend", async () => {
    process.env.SENTRY_DSN = DSN;
    const monitoringInit = await importMonitoringInit();
    await monitoringInit.initMonitoring();

    const beforeSend = initOptions().beforeSend as (event: SyntheticEvent) => SyntheticEvent;
    expect(typeof beforeSend).toBe("function");

    const event: SyntheticEvent = {
      request: {
        headers: { authorization: "Bearer secret", cookie: "session=abc" },
        cookies: { session: "abc" },
        data: { email: "shopper@example.com", address: "1 Test Street" },
        query_string: "token=secret",
      },
      user: { email: "shopper@example.com" },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: "actions/orders/index.js",
                  vars: {
                    email: "shopper@example.com",
                    address: "1 Test Street",
                    razorpay: { order_id: "order_test" },
                  },
                },
              ],
            },
          },
        ],
      },
    };

    const scrubbed = beforeSend(event);

    expect(scrubbed.request).toEqual({});
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.exception?.values?.[0].stacktrace?.frames?.[0].vars).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain("shopper@example.com");
    expect(JSON.stringify(scrubbed)).not.toContain("1 Test Street");
    expect(JSON.stringify(scrubbed)).not.toContain("session=abc");
  });
});
