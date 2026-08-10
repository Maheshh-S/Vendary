import FormSignIn from "@/modules/auth/forms/login/form";
import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-md px-4">
        <FormSignIn />
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