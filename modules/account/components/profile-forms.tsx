"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import toast from "react-hot-toast"
import * as z from "zod"

import { changePassword, updateProfile } from "@/actions/account/profile"
import { Button } from "@/components/ui/button"
import { Field, Label } from "@/components/ui/fieldset"
import { Input } from "@/components/ui/input"
import {
  ChangePasswordSchema,
  ProfileSchema,
  type ProfileInput,
} from "@/schemas/account/profile-schema"

/** The action never sees the confirmation field; this is a form-only check. */
const PasswordFormSchema = ChangePasswordSchema.extend({
  confirmPassword: z.string().min(1, "Confirm your new password"),
}).refine((values) => values.newPassword === values.confirmPassword, {
  path: ["confirmPassword"],
  message: "Both passwords must match.",
})

type PasswordFormValues = z.infer<typeof PasswordFormSchema>

export function ProfileForm({
  initial,
}: {
  initial: { firstName: string; lastName: string; avatarUrl: string }
}) {
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ProfileInput>({
    resolver: zodResolver(ProfileSchema),
    defaultValues: initial,
  })

  const onSubmit = async (values: ProfileInput) => {
    setIsPending(true)
    try {
      const result = await updateProfile(values)
      if (!result.ok) {
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (field in ProfileSchema.shape && messages[0]) {
              setError(field as keyof ProfileInput, { type: "server", message: messages[0] })
            }
          }
        }
        toast.error(result.message)
        return
      }
      toast.success("Profile updated")
      router.refresh()
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <Label htmlFor="profile-first-name">First name</Label>
          <Input id="profile-first-name" {...register("firstName")} />
          {errors.firstName && (
            <p className="mt-1 text-sm text-red-600">{errors.firstName.message}</p>
          )}
        </Field>
        <Field>
          <Label htmlFor="profile-last-name">Last name</Label>
          <Input id="profile-last-name" {...register("lastName")} />
          {errors.lastName && (
            <p className="mt-1 text-sm text-red-600">{errors.lastName.message}</p>
          )}
        </Field>
      </div>
      <Field>
        <Label htmlFor="profile-avatar">Avatar URL (optional)</Label>
        <Input
          id="profile-avatar"
          type="url"
          placeholder="https://images.unsplash.com/…"
          {...register("avatarUrl")}
        />
        {errors.avatarUrl && (
          <p className="mt-1 text-sm text-red-600">{errors.avatarUrl.message}</p>
        )}
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Only images from the allowed hosts (Unsplash, Pexels, Amazon, Pixabay,
          Tailwind, Google) can be used. Leave blank to remove your avatar.
        </p>
      </Field>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  )
}

export function PasswordForm() {
  const [isPending, setIsPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(PasswordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  })

  const onSubmit = async (values: PasswordFormValues) => {
    setMessage(null)

    setIsPending(true)
    try {
      const result = await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      })
      if (!result.ok) {
        if (result.fieldErrors?.currentPassword?.[0]) {
          setError("currentPassword", {
            type: "server",
            message: result.fieldErrors.currentPassword[0],
          })
        }
        if (result.fieldErrors?.newPassword?.[0]) {
          setError("newPassword", {
            type: "server",
            message: result.fieldErrors.newPassword[0],
          })
        }
        toast.error(result.message)
        return
      }
      reset()
      setMessage("Password changed. Other devices stay signed in until their session expires.")
      toast.success("Password changed")
    } finally {
      setIsPending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field>
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          {...register("currentPassword")}
        />
        {errors.currentPassword && (
          <p className="mt-1 text-sm text-red-600">{errors.currentPassword.message}</p>
        )}
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <Label htmlFor="account-new-password">New password</Label>
          <Input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            {...register("newPassword")}
          />
          {errors.newPassword && (
            <p className="mt-1 text-sm text-red-600">{errors.newPassword.message}</p>
          )}
        </Field>
        <Field>
          <Label htmlFor="account-confirm-password">Confirm new password</Label>
          <Input
            id="account-confirm-password"
            type="password"
            autoComplete="new-password"
            {...register("confirmPassword")}
          />
          {errors.confirmPassword && (
            <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
          )}
        </Field>
      </div>
      {message && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          {message}
        </p>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Changing your password does not sign out other devices: existing sessions
        stay valid until they expire. Sign out manually on shared devices.
      </p>
      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Change password"}
      </Button>
    </form>
  )
}
