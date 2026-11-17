import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";

export default function ClientsPage() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold mb-4">Clients</h1>
      <Suspense fallback={<p>Loading clients...</p>}>
        <ClientList />
      </Suspense>
    </main>
  );
}

async function ClientList() {
  const supabase = await createClient();
  const { data: clients, error } = await supabase
    .from("clients")
    .select()
    .order("name");

  if (error) {
    return <p>Could not load clients: {error.message}</p>;
  }

  return (
    <ul>
      {clients.map((client) => (
        <li key={client.id}>
          {client.name} {client.phone}
        </li>
      ))}
    </ul>
  );
}
