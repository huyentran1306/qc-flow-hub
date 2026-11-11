import { redirect } from "next/navigation";

// Depends on the database and cookies at request time.
export const dynamic = "force-dynamic";

export default function Home() {
  redirect("/dashboard");
}
