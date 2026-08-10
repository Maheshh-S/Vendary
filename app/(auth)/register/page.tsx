import FormSignUp from "@/modules/auth/forms/register/form";
import Link from "next/link";

export default function RegisterPage() {
  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-md px-4">
        <FormSignUp />
        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}