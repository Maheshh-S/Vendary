"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

import {
  createAddress,
  deleteAddress,
  setDefaultAddress,
  updateAddress,
} from "@/actions/account/addresses";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { SavedAddressInputSchema, type SavedAddressInput } from "@/schemas/account/address-schema";
import type { SavedAddressView } from "@/modules/account/types";

const emptyValues: SavedAddressInput = {
  label: undefined,
  firstName: "",
  lastName: "",
  phone: "",
  line1: "",
  line2: undefined,
  area: "",
  landmark: undefined,
  state: "",
  postalCode: "",
  country: "India",
  isDefault: false,
};

const toInput = (address: SavedAddressView): SavedAddressInput => ({
  label: address.label ?? undefined,
  firstName: address.firstName,
  lastName: address.lastName,
  phone: address.phone,
  line1: address.line1,
  line2: address.line2 ?? undefined,
  area: address.area,
  landmark: address.landmark ?? undefined,
  state: address.state,
  postalCode: address.postalCode,
  country: address.country,
  isDefault: address.isDefault,
});

/**
 * Create/edit form for one saved address. Server field errors are mapped back
 * onto the inputs; failures keep the form open.
 */
export function AddressForm({
  initialAddress,
  onDone,
  onCancel,
}: {
  initialAddress?: SavedAddressView;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<SavedAddressInput>({
    resolver: zodResolver(SavedAddressInputSchema),
    defaultValues: initialAddress ? toInput(initialAddress) : emptyValues,
  });

  const applyServerFieldErrors = (fieldErrors?: Record<string, string[]>): string | undefined => {
    if (!fieldErrors) return undefined;
    let firstMessage: string | undefined;
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const message = messages[0];
      if (!message) continue;
      firstMessage ??= message;
      if (field in SavedAddressInputSchema.shape) {
        setError(field as keyof SavedAddressInput, { type: "server", message });
      }
    }
    return firstMessage;
  };

  const onSubmit = async (values: SavedAddressInput) => {
    setIsPending(true);
    try {
      const result = initialAddress
        ? await updateAddress({ id: initialAddress.id, ...values })
        : await createAddress(values);
      if (!result.ok) {
        toast.error(applyServerFieldErrors(result.fieldErrors) ?? result.message);
        return;
      }
      toast.success(initialAddress ? "Address updated" : "Address saved");
      if (!initialAddress) reset(emptyValues);
      router.refresh();
      onDone?.();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2">
          <Label htmlFor="address-label">Label (optional)</Label>
          <Input id="address-label" placeholder="Home, Office…" {...register("label")} />
          {errors.label && <p className="mt-1 text-sm text-red-600">{errors.label.message}</p>}
        </Field>

        <Field>
          <Label htmlFor="address-first-name">First name</Label>
          <Input id="address-first-name" {...register("firstName")} />
          {errors.firstName && (
            <p className="mt-1 text-sm text-red-600">{errors.firstName.message}</p>
          )}
        </Field>
        <Field>
          <Label htmlFor="address-last-name">Last name</Label>
          <Input id="address-last-name" {...register("lastName")} />
          {errors.lastName && (
            <p className="mt-1 text-sm text-red-600">{errors.lastName.message}</p>
          )}
        </Field>

        <Field>
          <Label htmlFor="address-phone">Phone number</Label>
          <Input id="address-phone" inputMode="tel" {...register("phone")} />
          {errors.phone && <p className="mt-1 text-sm text-red-600">{errors.phone.message}</p>}
        </Field>
        <Field>
          <Label htmlFor="address-postal-code">Postal code</Label>
          <Input id="address-postal-code" inputMode="numeric" {...register("postalCode")} />
          {errors.postalCode && (
            <p className="mt-1 text-sm text-red-600">{errors.postalCode.message}</p>
          )}
        </Field>

        <Field className="sm:col-span-2">
          <Label htmlFor="address-line1">Address</Label>
          <Input id="address-line1" {...register("line1")} />
          {errors.line1 && <p className="mt-1 text-sm text-red-600">{errors.line1.message}</p>}
        </Field>
        <Field className="sm:col-span-2">
          <Label htmlFor="address-line2">Address line 2 (optional)</Label>
          <Input id="address-line2" {...register("line2")} />
          {errors.line2 && <p className="mt-1 text-sm text-red-600">{errors.line2.message}</p>}
        </Field>

        <Field>
          <Label htmlFor="address-area">Area/Neighborhood</Label>
          <Input id="address-area" {...register("area")} />
          {errors.area && <p className="mt-1 text-sm text-red-600">{errors.area.message}</p>}
        </Field>
        <Field>
          <Label htmlFor="address-landmark">Landmark (optional)</Label>
          <Input id="address-landmark" {...register("landmark")} />
          {errors.landmark && (
            <p className="mt-1 text-sm text-red-600">{errors.landmark.message}</p>
          )}
        </Field>

        <Field>
          <Label htmlFor="address-state">State</Label>
          <Input id="address-state" {...register("state")} />
          {errors.state && <p className="mt-1 text-sm text-red-600">{errors.state.message}</p>}
        </Field>
        <Field>
          <Label htmlFor="address-country">Country</Label>
          <Input id="address-country" {...register("country")} />
          {errors.country && <p className="mt-1 text-sm text-red-600">{errors.country.message}</p>}
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input type="checkbox" className="size-4 rounded" {...register("isDefault")} />
        Use as my default address
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : initialAddress ? "Save changes" : "Save address"}
        </Button>
        {onCancel && (
          <Button type="button" plain onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** One address card with ownership-scoped edit, default and delete controls. */
export function AddressCard({ address }: { address: SavedAddressView }) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const run = async (operation: () => Promise<{ ok: boolean; message?: string }>) => {
    setIsPending(true);
    try {
      const result = await operation();
      if (!result.ok) {
        toast.error(result.message ?? "Something went wrong.");
        return;
      }
      router.refresh();
    } finally {
      setIsPending(false);
    }
  };

  if (isEditing) {
    return (
      <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">Edit address</h3>
        <AddressForm
          initialAddress={address}
          onDone={() => setIsEditing(false)}
          onCancel={() => setIsEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      data-testid="saved-address"
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">
            {address.label || `${address.firstName} ${address.lastName}`.trim()}
          </p>
          {address.isDefault && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              Default
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {!address.isDefault && (
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => setDefaultAddress(address.id))}
              className="font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              Set default
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              if (!window.confirm("Delete this saved address? Past orders keep their address.")) {
                return;
              }
              void run(() => deleteAddress(address.id));
            }}
            className="font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
          >
            Delete
          </button>
        </div>
      </div>
      <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
        {address.firstName} {address.lastName}
        <br />
        {address.line1}
        {address.line2 ? (
          <>
            <br />
            {address.line2}
          </>
        ) : null}
        <br />
        {address.area}
        {address.landmark ? `, ${address.landmark}` : ""}
        <br />
        {address.state} {address.postalCode}, {address.country}
        <br />
        {address.phone}
      </p>
    </li>
  );
}
