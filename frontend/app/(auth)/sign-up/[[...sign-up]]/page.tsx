import { ClerkAuthPage } from "../../ClerkAuthPage";

/**
 * Catch-all route, mirroring sign-in: Clerk needs `/sign-up/continue` and the
 * other factor paths to resolve to this page.
 */
export default function SignUpPage() {
  return <ClerkAuthPage mode="sign-up" />;
}
