import { ClerkAuthPage } from "../../ClerkAuthPage";

/**
 * Catch-all route: Clerk's `<SignIn />` uses the path to decide which factors
 * to show, so `/sign-in/factor-one` and friends must all reach this page.
 */
export default function SignInPage() {
  return <ClerkAuthPage mode="sign-in" />;
}
