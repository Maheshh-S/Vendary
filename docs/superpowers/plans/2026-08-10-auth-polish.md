# Auth Polish + Google OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the user-visible auth bugs (invisible login errors, dead OAuth buttons, silent unverified flow, white-on-white error page, broken redirects) and wire Google OAuth fully — per `docs/superpowers/specs/2026-08-10-auth-polish-design.md`.

**Architecture:** Credentials (email/password + email verification) remain the primary flow and stays enforced. Google OAuth gets live via the existing NextAuth v5 setup (provider config + PrismaAdapter). The `User` schema gains the canonical `image` column the adapter requires. Both auth forms get real error/success surfaces (toast) and a shared Google button wired to the existing-but-unused `signInProvider` action.

**Tech Stack:** Next.js 15.2.8 (App Router, server actions), NextAuth v5 beta.25, @auth/prisma-adapter v2.8.0, Prisma, zod, react-hook-form, @tanstack/react-query, react-hot-toast, bcryptjs, Tailwind.

## Global Constraints

- No test framework exists in this repo (`package.json` scripts: dev/build/start/lint/postinstall only). Verification = `npm run lint` + `npm run build` + Playwright browser checks + targeted curl/DB checks, per Task 10. TDD steps below are replaced by explicit verify commands; run them exactly.
- Email verification stays enforced — unverified users must not log in (spec decision 1).
- Google-only OAuth: `auth.config.ts` must no longer import Github/Twitter/LinkedIn (spec §2).
- `User` model gains `image String?` (adapter requirement) — migration must be committed.
- No secrets in code. Credentials only via env (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`).
- Email normalization: `.trim().toLowerCase()` in both zod schemas AND in `GetUserByEmail`.
- Single login-failure message: exactly `"Invalid email or password"` everywhere except the intentional verify-email prompt.
- Client env flags are forbidden; the Google env guard lives server-side in `signInProvider`.
- `.env*` is gitignored — `.env.example` needs a `!.env.example` exception to be committable.

---

### Task 1: Add `image` column to User + run migration

**Files:**
- Modify: `prisma/schema.prisma` (model User, ~line 62-80)
- Create (generated): `prisma/migrations/<timestamp>_add_image_to_user/migration.sql`

**Interfaces:**
- Consumes: existing `User` model fields.
- Produces: `User.image: String?` — consumed by Task 4 (`jwt` callback) and required by the PrismaAdapter `createUser` (it spreads OAuth `image` into `prisma.user.create`; without this column the first Google sign-in throws "Unknown argument `image`").

- [ ] **Step 1: Add the field to the schema**

In `prisma/schema.prisma`, inside `model User`, right after `profilePic String?` (line ~66):

```prisma
  profilePic     String?
  image          String?
  password       String?
```

- [ ] **Step 2: Create + apply the migration**

Run: `npx prisma migrate dev --name add_image_to_user`
Expected: migration applied to dev DB, `prisma client` regenerated, no errors. If the dev DB is unreachable, run `npx prisma db push` instead and note it.

Verify the generated column exists:

Run: `grep -n '"image"\|image TEXT' prisma/migrations/*_add_image_to_user/migration.sql`
Expected: an `ALTER TABLE "users" ADD COLUMN "image" TEXT;` line.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add image column to user for oauth avatars"
```

---

### Task 2: Normalize emails (schemas + user lookup)

**Files:**
- Modify: `schemas/auth/login-schema.ts:4`
- Modify: `schemas/auth/register-schema.tsx:4`
- Modify: `actions/user/index.ts:16-20` (findFirst where clause)

**Interfaces:**
- Consumes: nothing new.
- Produces: normalized emails everywhere downstream. `GetUserByEmail(email)` becomes case/whitespace-insensitive so signup `Foo@Bar.com` resolves at login as `foo@bar.com`.

- [ ] **Step 1: Update LoginSchema**

`schemas/auth/login-schema.ts` → replace lines 3-6 with:

```ts
export const LoginSchema = z.object({
    email: z.string().email().trim().toLowerCase(),
    password: z.string().min(1, "Please Enter a Password.")
})
```

- [ ] **Step 2: Update RegisterSchema**

`schemas/auth/register-schema.tsx` → replace line 4 with:

```tsx
    email: z.string().email().min(1, { message: "Email is required" }).trim().toLowerCase(),
```

- [ ] **Step 3: Normalize in GetUserByEmail**

`actions/user/index.ts` → inside `GetUserByEmail`, right after the `if(!email)` guard, normalize, and lower the where:

```ts
    const normalizedEmail = email.trim().toLowerCase();
```

then change the query (lines 16-20) to:

```ts
        const user = await prisma.user.findFirst({
            where: {
                email: normalizedEmail
            }
        });
```

- [ ] **Step 4: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

Run: `npx tsc --noEmit` (via `node_modules/.bin/tsc --noEmit`)
Expected: exit 0, no output errors.

- [ ] **Step 5: Commit**

```bash
git add schemas/auth/login-schema.ts schemas/auth/register-schema.tsx actions/user/index.ts
git commit -m "fix: normalize emails in schemas and user lookup"
```

---

### Task 3: Google-only provider + timing-hardened authorize

**Files:**
- Modify: `auth.config.ts` (entire file, 43 lines)

**Interfaces:**
- Consumes: `LoginSchema`, `GetUserByEmail` (existing).
- Produces: `authConfig.providers = [Google, CredentialsProvider]`; `authorize` returns `null` for every failure with flat timing (dummy bcrypt compare when user missing). Consumed by `auth.ts` (Task 4) and `middleware.ts`.

- [ ] **Step 1: Rewrite auth.config.ts**

Replace the entire contents of `auth.config.ts` with:

```ts
import Google from "next-auth/providers/google"
import type { NextAuthConfig } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs"
import { LoginSchema } from "./schemas/auth/login-schema"
import { GetUserByEmail } from "./actions/user"

const DUMMY_PASSWORD = "dummy-password-for-timing"
let dummyHash: string | undefined

async function getDummyHash(): Promise<string> {
    if (!dummyHash) {
        dummyHash = await bcrypt.hash(DUMMY_PASSWORD, 10)
    }
    return dummyHash
}

export default {
    providers: [
        Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
        }),
        CredentialsProvider({
            name: "credentials",
            async authorize(credentials){
                const {
                    success,
                    data
                } = LoginSchema.safeParse(credentials);

                if(!success){
                    return null;
                }

                const user = await GetUserByEmail(data?.email);

                // Always run a bcrypt compare (dummy hash when user not found)
                // so timing does not reveal whether the account exists.
                const hashToCompare = user?.password ?? await getDummyHash();
                const password_match = await bcrypt.compare(data.password, hashToCompare);

                if(user && password_match){
                    return user;
                }

                return null;
            }
        }),
    ]
} satisfies NextAuthConfig
```

- [ ] **Step 2: Verify providers list**

Run: `grep -n "import\|providers" auth.config.ts`
Expected: only `Google` + `CredentialsProvider` imports; no github/twitter/linkedin.

- [ ] **Step 3: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

- [ ] **Step 4: Commit**

```bash
git add auth.config.ts
git commit -m "fix: google-only oauth and timing-hardened credentials authorize"
```

---

### Task 4: Populate session avatar (jwt/session callbacks)

**Files:**
- Modify: `auth.ts:31-53` (jwt + session callbacks)

**Interfaces:**
- Consumes: `User.image` (Task 1), `User.profilePic` (exists), `GetUserById` (exists).
- Produces: `token.picture` set from `image ?? profilePic`, surfaced as `session.user.image` — consumed by `modules/shopping/components/shopping-nav/user-button/index.tsx:18` (avatar fallback `'/default-profile-pic.png'`).

- [ ] **Step 1: Update the jwt callback**

`auth.ts` → replace the `jwt` callback (lines 31-41) with:

```ts
        async jwt({token}){
            if(!token.sub) return token; //User Logged Out
            const existingUser = await GetUserById(token.sub);
            if(!existingUser) return token;
            token.role = existingUser.role;
            token.email = existingUser.email;
            token.name = existingUser.firstName + " " + existingUser.lastName;
            token.picture = existingUser.image ?? existingUser.profilePic ?? null;

            return token;
        },
```

- [ ] **Step 2: Surface picture in the session callback**

`auth.ts` → in the `session` callback, after the existing `if(token.role && session.user)` block (line ~48), add:

```ts
            if(token.picture && session.user){
                session.user.image = token.picture;
            }
```

- [ ] **Step 3: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

- [ ] **Step 4: Commit**

```bash
git add auth.ts
git commit -m "fix: populate session user image from profile"
```

---

### Task 5: Harden auth server actions

**Files:**
- Modify: `actions/auth/index.ts` (214 lines — Login, signInProvider, Register, newVerification)

**Interfaces:**
- Consumes: `signIn` from `@/auth`, `generateVerificationToken`, `sendVerificationEmail`, `GetUserByEmail` (all existing).
- Produces:
  - `Login(credentials) => { success: string, success_status: true } | throws Error("Invalid email or password" | "Please Verify Your Email to Login." | generic)` — unverified path now **awaits** the mail send and swallows failures as a throw.
  - `signInProvider("google") => void | { error: string, success_status: false }` — google-only, env-guarded.
  - `Register` — typo fix.

- [ ] **Step 1: Rewrite signInProvider (google-only + env guard)**

`actions/auth/index.ts` → replace lines 24-61 with:

```ts
export const signInProvider = async (provider: 'google') => {
    if (!process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET) {
        return {
            "error": "Google sign-in is not configured.",
            success_status: false
        }
    }
    try {
        await signIn(provider, { redirectTo: DEFAULT_LOGIN_REDIRECT });
    } catch (error) {
        if(error instanceof AuthError){
            switch (error.type) {
                case "CredentialsSignin":
                    return {
                        "error" : "Incorrect Username or Password!",
                        success_status: false
                    }

                    case "UntrustedHost":
                        return {
                            "error" : "Untrusted host",
                            success_status: false
                        }
                    case "AccessDenied":
                        return {
                            "error" : "Please Verify Your Email to Login.",
                            success_status: false
                        }

                default:
                    return {
                        "error" : "Something Went Wrong!",
                        success_status: false
                    }
            }
        }
        throw error;
    }
};
```

- [ ] **Step 2: Unify Login failure messages + await mail**

`actions/auth/index.ts` → replace the `Login` body (lines 63-125) with:

```ts
export const Login = async (credentials : z.infer<typeof LoginSchema>) => {
    const {
        data,
        success
    } = LoginSchema.safeParse(credentials)

    if(!success){
        throw new Error("Invalid email or password")
    }

    const {
        email,
        password
    } = data;

    const existingUser = await GetUserByEmail(email);

    if(!existingUser || !existingUser.email || !existingUser.password){
        throw new Error("Invalid email or password")
    }

    if(!existingUser.emailVerified){
        const verificationToken = await generateVerificationToken(existingUser.email);

        try {
            await sendVerificationEmail(verificationToken.email, verificationToken.token)
        } catch (error) {
            console.error("Failed to send verification email:", error)
            throw new Error("Could not send the verification email. Please try again.")
        }

        return {
            "success" : "Verification Email Sent. Check your inbox.",
            success_status: true
        }
    }

    try {
        await signIn("credentials", {
            email,
            password,
            redirectTo: DEFAULT_LOGIN_REDIRECT
        })
    } catch (error) {
        if(error instanceof AuthError){
            switch (error.type) {
                case "CredentialsSignin":
                    throw new Error("Invalid email or password")

                    case "UntrustedHost":
                        throw new Error("Untrusted host")
                    case "AccessDenied":
                        throw new Error("Please Verify Your Email to Login.")

                default:
                    throw new Error("Something Went Wrong!")
            }
        }
        throw error;
    }

    return {
        "success" : "Signed in successfully.",
        success_status:true
    }
}
```

- [ ] **Step 3: Fix Register message typo**

`actions/auth/index.ts:172` → `'Confirmation Email Sent!.'` becomes `'Confirmation Email Sent!'` (drop the trailing period after `!`).

- [ ] **Step 4: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

Run: `grep -rn "User not found\.\|Password is not set" actions/ auth.config.ts`
Expected: no matches (enumeration messages gone).

- [ ] **Step 5: Commit**

```bash
git add actions/auth/index.ts
git commit -m "fix: unify login errors, await verification mail, guard google provider"
```

---

### Task 6: Login form — visible feedback + Google button

**Files:**
- Modify: `modules/auth/forms/login/form.tsx` (93 lines)
- Create: `modules/auth/components/google-sign-in-button.tsx`

**Interfaces:**
- Consumes: `Login` action (Task 5), `toast` from `react-hot-toast`, `Button`/`Field`/`Label`/`Input` UI kit.
- Produces: `FormSignIn({ onSuccess? }: { onSuccess?: () => void })` — optional success callback consumed by Task 8; renders `<GoogleSignInButton disabled={isPending} />`.

- [ ] **Step 1: Create the shared Google button**

Create `modules/auth/components/google-sign-in-button.tsx`:

```tsx
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
    const result = await signInProvider("google");
    setIsPending(false);
    if (result && "error" in result) {
      toast.error(result.error);
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
```

- [ ] **Step 2: Rewrite the login form**

Replace the entire contents of `modules/auth/forms/login/form.tsx` with:

```tsx
"use client";
import React from "react";
import { IconLoader } from "@tabler/icons-react";
import { Field, Label } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PROJECT_NAME } from "@/metadata";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { useMutation } from "@tanstack/react-query";
import {Login} from "@/actions/auth";
import { LoginSchema, LoginSchemaType } from "@/schemas/auth/login-schema";
import { Logo } from "@/components/global/logo";
import GoogleSignInButton from "@/modules/auth/components/google-sign-in-button";

type Props = {
  onSuccess?: () => void;
};

export default function FormSignIn({ onSuccess }: Props) {
  const {
    handleSubmit,
    formState: { errors },
    register,
    reset
  } = useForm<LoginSchemaType>({
    resolver: zodResolver(LoginSchema),
  });

  const {
    mutate: login,
    isPending
  } = useMutation({
    mutationKey: ['login'],
    mutationFn: Login,
    onSuccess: (data) => {
      reset();
      toast.success(data.success);
      onSuccess?.();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    }
  })

  const onSubmit = (data: LoginSchemaType) => {
    login(data);
  };
  return (
    <div className="mx-auto w-full max-w-md rounded-none p-4 md:p-8">
      <h2 className="text-xl font-bold">Welcome back to <Logo /></h2>
      <p className="mt-2 max-w-sm text-sm">
        Login to your precious {PROJECT_NAME.toLocaleLowerCase()} account and start your journey.
      </p>
      <form className="mt-8" onSubmit={handleSubmit(onSubmit)}>
        <Field className="my-4">
          <Label htmlFor="email">Email Address</Label>
          <Input
            {...register("email", { required: "Email is required" })}
            id="email"
            placeholder="projectmayhem@fc.com"
            type="email"
          />
          {errors.email && (
            <p className="dark:text-red-300 text-red-800 text-sm mt-1">
              {errors.email.message}
            </p>
          )}
        </Field>
        <Field className="my-4">
          <Label htmlFor="password">Password</Label>
          <Input
            {...register("password")}
            id="password"
            placeholder="••••••••"
            type="password"
          />
          {errors.password && (
            <p className="dark:text-red-300 text-red-800 text-sm mt-1">
              {errors.password.message}
            </p>
          )}
        </Field>
        <Button disabled={isPending} type="submit" className="w-full cursor-pointer mt-6">
          { isPending ? <IconLoader size={22} className="animate-spin" />: "Sign in" }
        </Button>

        <div className="my-8 h-[1px] w-full bg-gradient-to-r from-transparent via-neutral-300 to-transparent dark:via-neutral-700" />

        <GoogleSignInButton disabled={isPending} />
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

- [ ] **Step 4: Commit**

```bash
git add modules/auth/forms/login/form.tsx modules/auth/components/google-sign-in-button.tsx
git commit -m "feat: visible login feedback and google sign-in button"
```

---

### Task 7: Register form — Google button + real error messages

**Files:**
- Modify: `modules/auth/forms/register/form.tsx` (133 lines)

**Interfaces:**
- Consumes: `Register` action, `GoogleSignInButton` (Task 6).
- Produces: `FormSignUp({ onSuccess? }: { onSuccess?: () => void })` — optional success callback consumed by Task 8.

- [ ] **Step 1: Rewrite the register form**

Replace the entire contents of `modules/auth/forms/register/form.tsx` with:

```tsx
"use client";
import React from "react";
import { IconLoader } from "@tabler/icons-react";
import { Field, Label } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PROJECT_NAME } from "@/metadata";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import {
  RegisterSchema,
  RegisterSchemaType,
} from "@/schemas/auth/register-schema";
import { useMutation } from "@tanstack/react-query";
import {Register} from "@/actions/auth";
import GoogleSignInButton from "@/modules/auth/components/google-sign-in-button";

type Props = {
  onSuccess?: () => void;
};

export default function FormSignUp({ onSuccess }: Props) {
  const {
    handleSubmit,
    formState: { errors },
    register,
    reset,
  } = useForm<RegisterSchemaType>({
    resolver: zodResolver(RegisterSchema),
  });

  const {
    mutate: registerUser,
    isPending
  } = useMutation({
    mutationKey: ['register'],
    mutationFn: Register,
    onMutate: () => {
      toast.loading("Creating your account", { id: "register" });
    },
    onSuccess: (data) => {
      toast.success(data.success, { id: "register" });
      reset();
      onSuccess?.();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong",
        { id: "register" }
      );
    }
  })

  const onSubmit = (data: RegisterSchemaType) => {
    registerUser(data);
  };
  return (
    <div className="mx-auto w-full max-w-md rounded-none p-4 md:p-8">
      <h2 className="text-xl font-bold">Welcome to {PROJECT_NAME}</h2>
      <p className="mt-2 max-w-sm text-sm">
        Sign Up to {PROJECT_NAME.toLocaleLowerCase()} and start browsing our curated collection.
      </p>
      <form className="mt-8" onSubmit={handleSubmit(onSubmit)}>
        <div className="flex flex-col space-y-2 md:flex-row md:space-y-0 md:space-x-2">
          <Field className="w-full">
            <Label htmlFor="firstname">First name</Label>
            <Input
              {...register("firstName")}
              id="firstname"
              placeholder="Tyler"
              type="text"
            />
            {errors.firstName && (
              <p className="dark:text-red-300 text-red-800 text-sm mt-1">
                {errors.firstName.message}
              </p>
            )}
          </Field>
          <Field className="w-full">
            <Label htmlFor="lastname">Last name</Label>
            <Input
              {...register("lastName")}
              id="lastname"
              placeholder="Durden"
              type="text"
            />
            {errors.lastName && (
              <p className="dark:text-red-300 text-red-800 text-sm mt-1">
                {errors.lastName.message}
              </p>
            )}
          </Field>
        </div>
        <Field className="my-4">
          <Label htmlFor="email">Email Address</Label>
          <Input
            {...register("email", { required: "Email is required" })}
            id="email"
            placeholder="projectmayhem@fc.com"
            type="email"
          />
          {errors.email && (
            <p className="dark:text-red-300 text-red-800 text-sm mt-1">
              {errors.email.message}
            </p>
          )}
        </Field>
        <Field className="my-4">
          <Label htmlFor="password">Password</Label>
          <Input
            {...register("password")}
            id="password"
            placeholder="••••••••"
            type="password"
          />
          {errors.password && (
            <p className="dark:text-red-300 text-red-800 text-sm mt-1">
              {errors.password.message}
            </p>
          )}
        </Field>
        <Button disabled={isPending} type="submit" className="w-full cursor-pointer mt-6">
          { isPending ? <IconLoader size={22} className="animate-spin" />: "Sign up" }
        </Button>

        <div className="my-8 h-[1px] w-full bg-gradient-to-r from-transparent via-neutral-300 to-transparent dark:via-neutral-700" />

        <GoogleSignInButton disabled={isPending} />
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

- [ ] **Step 3: Commit**

```bash
git add modules/auth/forms/register/form.tsx
git commit -m "feat: register form error surfaces and google sign-in button"
```

---

### Task 8: Auto-close modals on success

**Files:**
- Modify: `modules/auth/components/sign-in-component.tsx:37-39`
- Modify: `modules/auth/components/sign-up-component.tsx:36-38`

**Interfaces:**
- Consumes: `FormSignIn`/`FormSignUp` `onSuccess` props (Tasks 6/7).
- Produces: modals close themselves on successful submit/sign-in.

- [ ] **Step 1: Sign-in modal**

`modules/auth/components/sign-in-component.tsx` → replace the `Dialog` block (lines 37-39) with:

```tsx
        <Dialog className="mt-14" open={isOpen} onClose={setIsOpen}>
          <FormSignIn onSuccess={() => setIsOpen(false)} />
        </Dialog>
```

- [ ] **Step 2: Sign-up modal**

`modules/auth/components/sign-up-component.tsx` → replace the `Dialog` block (lines 36-38) with:

```tsx
        <Dialog className="mt-8" open={isOpen} onClose={setIsOpen}>
          <FormSignUp onSuccess={() => setIsOpen(false)} />
        </Dialog>
```

- [ ] **Step 3: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

- [ ] **Step 4: Commit**

```bash
git add modules/auth/components/sign-in-component.tsx modules/auth/components/sign-up-component.tsx
git commit -m "feat: close auth modals on successful submit"
```

---

### Task 9: Route/layout bug fixes

**Files:**
- Modify: `routes.ts:25-26,43`
- Modify: `app/(admin)/layout.tsx:15`
- Modify: `app/(auth)/error/page.tsx:25`

**Interfaces:**
- Consumes: nothing new.
- Produces: `/returns` public, dead auth routes removed, non-admin redirect target `/` instead of the raw-JSON `/home` debug page, readable error-page heading.

- [ ] **Step 1: Fix publicRoutes `'returns'`**

`routes.ts:43` → `'returns'` becomes `'/returns'`.

- [ ] **Step 2: Remove dead authRoutes entries**

`routes.ts:25-26` → delete the lines `'/onboarding',` and `'/password/reset/form',` from `authRoutes`, leaving:

```ts
export const authRoutes = [
    '/login',
    '/register',
    '/error',
]
```

- [ ] **Step 3: Non-admin redirect**

`app/(admin)/layout.tsx:15` → `redirect("/home")` becomes `redirect("/")`.

- [ ] **Step 4: Error page heading contrast**

`app/(auth)/error/page.tsx:25` → `className="text-2xl font-semibold text-white"` becomes `className="text-2xl font-semibold text-zinc-900 dark:text-white"`.

- [ ] **Step 5: Verify**

Run: `npm run lint`
Expected: `✔ No ESLint warnings or errors`

Run: `grep -n "onboarding\|password/reset/form\|'returns'" routes.ts`
Expected: no output (all removed/fixed).

- [ ] **Step 6: Commit**

```bash
git add routes.ts "app/(admin)/layout.tsx" "app/(auth)/error/page.tsx"
git commit -m "fix: correct public routes, admin redirect, and error page contrast"
```

---

### Task 10: Env docs + full verification

**Files:**
- Create: `.env.example`
- Modify: `.gitignore` (`.env*` rule — add `!.env.example` exception)

**Interfaces:**
- Consumes: everything above.
- Produces: documented Google OAuth setup + verification evidence.

- [ ] **Step 1: Create .env.example**

Create `.env.example` in the repo root:

```bash
# --- Authentication ---
# Auth.js v5 secret (generate: openssl rand -base64 32)
AUTH_SECRET=

# Google OAuth (console.cloud.google.com -> Credentials -> OAuth client ID (Web))
# Authorized redirect URI: http://localhost:3000/api/auth/callback/google
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# --- Email (Resend) ---
RESEND_API_KEY=

# --- Database ---
DATABASE_URL=

# --- Redis (optional; cache disabled when absent) ---
REDIS_URL=

# --- Site ---
NEXT_PUBLIC_SITE_URL=http://localhost:3000
BASE_URL=http://localhost:3000
```

- [ ] **Step 2: Allow committing .env.example**

In `.gitignore`, under the `# env files (can opt-in for committing if needed)` block (line ~34), change:

```
.env*
```

to:

```
.env*
!.env.example
```

- [ ] **Step 3: Lint + typecheck + build**

Run: `npm run lint`  → expected `✔ No ESLint warnings or errors`
Run: `npx tsc --noEmit` → expected exit 0
Run: `npm run build` → expected success, `/login`, `/register`, `/error` routes present and static.

- [ ] **Step 4: Browser verification (Playwright)**

Start a clean dev server, then verify:
1. `GET /login` → 200; form renders; single "Continue with Google" button; `shadow-input` gone.
2. `GET /register` → 200; cross-link to /login works; one Google button.
3. Wrong-password login (admin-created user, bad password) → error toast "Invalid email or password" appears (previously silent).
4. Unverified user login → toast "Verification Email Sent. Check your inbox."
5. Nav modal (cart page or shopping nav "Login" button) → submit → dialog closes on success.
6. `GET /error?error=CredentialsSignin` → 200, heading readable on light background.
7. `GET /returns` while logged out → 200 (previously 307 → `/`).
8. `GET /admin` while logged out → 307 → `/`.
9. Google button with no `AUTH_GOOGLE_ID/SECRET` → toast "Google sign-in is not configured."
10. Register a new user `Test.User@Example.com` → email stored lowercase `test.user@example.com`.

- [ ] **Step 5: Commit**

```bash
git add .env.example .gitignore
git commit -m "docs: add env example with google oauth setup"
```

- [ ] **Step 6: Push**

```bash
git push origin main
```