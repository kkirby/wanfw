import { redirect } from "next/navigation";
import { hasAdminUser } from "../../lib/session-db";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  // Dead once an admin account exists -- redirect to login rather than
  // rendering a form that would only ever error (docs/t5.3-decisions.md).
  if (hasAdminUser()) {
    redirect("/login");
  }
  return <SetupForm />;
}
