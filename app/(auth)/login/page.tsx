import FormSignIn from "@/modules/auth/forms/login/form";
import Link from "next/link";

type Props = {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const callbackParam = params.callbackUrl;
  const callbackUrl = Array.isArray(callbackParam) ? callbackParam[0] : callbackParam;

  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-md px-4">
        <FormSignIn callbackUrl={callbackUrl} />
        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Don&apos;t have an account?{" "}
          <Link
            href="/register"
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
