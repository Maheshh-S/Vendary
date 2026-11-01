import { prisma } from "@/lib/db/prisma";

export const getVerificationTokenByEmail = async (email: string) => {
  const db = prisma;
  try {
    const verificationToken = db.verificationToken.findFirst({
      where: {
        email: email,
      },
    });
    return verificationToken;
  } catch (error) {
    console.error(error);
    throw new Error("Error while fetching verification token");
  }
};

export const getVerificationTokenByToken = async (token: string) => {
  const db = prisma;
  try {
    const verificationToken = db.verificationToken.findUnique({
      where: {
        token: token,
      },
    });
    return verificationToken;
  } catch (error) {
    console.error({ error });
    throw new Error("Error while fetching verification token");
  }
};

export const getPasswordResetTokenByEmail = async (email: string) => {
  const db = prisma;
  try {
    // `email` alone is not unique (the schema's unique key is
    // `[email, token]`), so this must be a findFirst.
    const resetToken = await db.passwordResetToken.findFirst({
      where: {
        email: email,
      },
    });
    return resetToken;
  } catch (error) {
    console.error(error);
    throw new Error("Error while fetching password reset token");
  }
};

export const getPasswordResetTokenByToken = async (token: string) => {
  const db = prisma;
  try {
    const resetToken = await db.passwordResetToken.findUnique({
      where: {
        token: token,
      },
    });
    return resetToken;
  } catch (error) {
    console.error(error);
    throw new Error("Error while fetching password reset token");
  }
};
