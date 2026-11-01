import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { PasswordForm, ProfileForm } from "@/modules/account/components/profile-forms";

export const metadata = { title: "Account settings | Vendary" };

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      image: true,
      profilePic: true,
      password: true,
    },
  });

  if (!user) {
    redirect("/");
  }

  return (
    <main className="mx-auto my-8 max-w-3xl px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Account settings</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{user.email}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Link
            href="/account/addresses"
            className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
          >
            Saved addresses
          </Link>
          <Link
            href="/my-orders"
            className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400"
          >
            My orders
          </Link>
        </div>
      </div>

      <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Profile
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Your name appears on reviews and in the store header.
        </p>
        <div className="mt-4">
          <ProfileForm
            initial={{
              firstName: user.firstName ?? "",
              lastName: user.lastName ?? "",
              avatarUrl: user.image ?? user.profilePic ?? "",
            }}
          />
        </div>
      </section>

      <section className="mt-8 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Password
        </h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {user.password
            ? "Choose a new password. Your current password is required."
            : "This account signs in with an external provider, so there is no password to change."}
        </p>
        <div className="mt-4">
          {user.password ? (
            <PasswordForm />
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Manage your password with your sign-in provider.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
