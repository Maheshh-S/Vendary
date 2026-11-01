"use client";

import { useState } from "react";
import Link from "next/link";
import { IconLoader } from "@tabler/icons-react";

import { resetPassword } from "@/actions/auth/password-reset";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";

export default function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const missingToken = token.trim() === "";

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }
    if (password.length > 72) {
      setError("Password cannot exceed 72 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Both passwords must match.");
      return;
    }

    setIsPending(true);
    try {
      const result = await resetPassword(token, password);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDone(true);
    } finally {
      setIsPending(false);
    }
  };

  if (missingToken) {
    return (
      <div className="mx-auto w-full max-w-md p-4 md:p-8">
        <h2 className="text-xl font-bold">Invalid reset link</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400" role="alert">
          This link is missing its reset token. Request a new email from the forgot-password page.
        </p>
        <p className="mt-6 text-sm">
          <Link
            href="/forgot-password"
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Request a new reset link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto w-full max-w-md p-4 md:p-8">
        <h2 className="text-xl font-bold">Password updated</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400" role="status">
          Your password has been changed. Sign in with your new password to continue. Other devices
          stay signed in until their session expires, so sign out on any shared device.
        </p>
        <Button href="/login" className="mt-6 w-full">
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md rounded-none p-4 md:p-8">
      <h2 className="text-xl font-bold">Choose a new password</h2>
      <p className="mt-2 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
        This link can be used once and expires one hour after it was requested.
      </p>

      <form className="mt-8" onSubmit={onSubmit} noValidate>
        <Field className="my-4">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field className="my-4">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input
            id="confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}

        <Button disabled={isPending} type="submit" className="mt-6 w-full cursor-pointer">
          {isPending ? <IconLoader size={22} className="animate-spin" /> : "Update password"}
        </Button>
      </form>
    </div>
  );
}
