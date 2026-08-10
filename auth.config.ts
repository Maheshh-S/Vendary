import Google from "next-auth/providers/google"
import type { NextAuthConfig } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs"
import { LoginSchema } from "./schemas/auth/login-schema"
import { GetUserByEmail } from "./actions/user"
import { getDummyHash } from "@/lib/dummy-hash"

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