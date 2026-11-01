import ResetPasswordForm from "@/modules/auth/forms/password-reset/reset-password-form";

type Props = {
  searchParams: Promise<{ token?: string | string[] }>;
};

/**
 * Public: the emailed link lands here. The token is read server-side and
 * handed to the client form; it is validated and consumed by the action.
 */
export default async function PasswordResetPage({ searchParams }: Props) {
  const { token } = await searchParams;
  const value = typeof token === "string" ? token : "";

  return (
    <div className="grid h-full place-items-center">
      <ResetPasswordForm token={value} />
    </div>
  );
}
