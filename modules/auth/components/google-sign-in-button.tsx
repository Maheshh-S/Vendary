"use client"
import React, { useState } from "react";
import { IconBrandGoogle, IconLoader } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import toast from "react-hot-toast";
import { signInProvider } from "@/actions/auth";

type Props = {
  disabled?: boolean;
};

export default function GoogleSignInButton({ disabled }: Props) {
  const [isPending, setIsPending] = useState(false);

  const handleGoogleSignIn = async () => {
    setIsPending(true);
    try {
      const result = await signInProvider("google");
      if (result && "error" in result) {
        toast.error(result.error);
      }
    } catch (error) {
      // Successful OAuth sign-in redirects via NEXT_REDIRECT — Next performs
      // the navigation itself, so there is nothing to toast.
      if (error instanceof Error && error.message.includes("NEXT_REDIRECT")) return;
      toast.error("Something Went Wrong!");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Button
      type="button"
      outline
      className="w-full cursor-pointer"
      disabled={disabled || isPending}
      onClick={handleGoogleSignIn}
    >
      {isPending ? <IconLoader size={22} className="animate-spin" /> : <IconBrandGoogle size={22} />}
      <span>Continue with Google</span>
    </Button>
  );
}