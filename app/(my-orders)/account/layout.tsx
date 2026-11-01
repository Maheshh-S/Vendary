import ShoppingLayout from "@/modules/shopping/layout/shopping-layout"

type Props = {
  children: React.ReactNode
}

/**
 * Account pages use the storefront chrome so the signed-in name in the header
 * is visible while editing profile or addresses.
 */
const AccountLayout = ({ children }: Props) => (
  <ShoppingLayout>{children}</ShoppingLayout>
)

export default AccountLayout
