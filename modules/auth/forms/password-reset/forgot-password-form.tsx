"use client";

import { useState } from "react";
import Link from "next/link";
import { IconLoader } from "@tabler/icons-react";

import { requestPasswordReset } from "@/actions/auth/password-reset";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsPending(true);
    try {
      // The action is deliberately enumeration-safe: the same copy comes back
      // for unknown addresses, so the UI must not add any account detail.
      const result = await requestPasswordReset(email);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMessage(result.data.message);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md rounded-none p-4 md:p-8">
      <h2 className="text-xl font-bold">Reset your password</h2>
      <p className="mt-2 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        Enter the email address on your account and we&apos;ll send a reset link.
      </p>

      <form className="mt-8" onSubmit={onSubmit} noValidate>
        <Field className="my-4">
          <Label htmlFor="forgot-email">Email Address</Label>
          <Input
            id="forgot-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="projectmayhem@fc.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
            {message}
          </p>
        )}

        <Button
          disabled={isPending || email.trim() === ""}
          type="submit"
          className="mt-6 w-full cursor-pointer"
        >
          {isPending ? <IconLoader size={22} className="animate-spin" /> : "Send reset link"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
        Remembered it?{" "}
        <Link
          href="/login"
          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
