import ForgotPasswordForm from "@/modules/auth/forms/password-reset/forgot-password-form"

/**
 * Public: reachable before sign-in. The response is always the same generic
 * message, so the page cannot be used to discover registered addresses.
 */
export default function ForgotPasswordPage() {
  return (
    <div className="grid h-full place-items-center">
      <ForgotPasswordForm />
    </div>
  )
}
