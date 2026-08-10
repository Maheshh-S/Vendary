import bcrypt from "bcryptjs"

const DUMMY_PASSWORD = "dummy-password-for-timing"
let dummyHash: string | undefined

export async function getDummyHash(): Promise<string> {
    if (!dummyHash) {
        dummyHash = await bcrypt.hash(DUMMY_PASSWORD, 10)
    }
    return dummyHash
}