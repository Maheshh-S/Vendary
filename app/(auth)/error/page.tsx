"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  Configuration: "There is a problem with the server configuration.",
  AccessDenied: "You don't have permission to sign in.",
  Verification: "This sign-in link is no longer valid or has already been used.",
  CredentialsSignin: "The email or password you entered is incorrect.",
  OAuthAccountNotLinked:
    "An account with this email already exists using a different sign-in method.",
  Default: "Something went wrong while trying to sign you in. Please try again.",
};

function ErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error") ?? "Default";
  const message = ERROR_MESSAGES[error] ?? ERROR_MESSAGES.Default;

  return (
    <div className="grid h-full place-items-center p-4 text-center">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-white">Unable to sign in</h1>
        <p className="mt-3 text-zinc-400">{message}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button href="/login">Try again</Button>
          <Button href="/" outline>
            Go home
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function ErrorPage() {
  return (
    <Suspense fallback={null}>
      <ErrorContent />
    </Suspense>
  );
}