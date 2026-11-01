import Link from "next/link";

/**
 * One search box for both admin tables. A plain GET form: submitting resets
 * `page` (the results change) and keeps the dashboard server-rendered.
 */
export default function AdminSearchControls({ q = "" }: { q?: string }) {
  return (
    <form
      action="/admin"
      method="get"
      role="search"
      className="mt-6 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center"
    >
      <label htmlFor="admin-search" className="sr-only">
        Search products and orders
      </label>
      <input
        id="admin-search"
        name="q"
        type="search"
        defaultValue={q}
        maxLength={100}
        placeholder="Search products (name, tag) or orders (id, payment id, email)"
        className="w-full flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm shadow-sm transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-300"
        data-testid="admin-search-input"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-slate-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-slate-500"
        >
          Search
        </button>
        {q && (
          <Link
            href="/admin"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
