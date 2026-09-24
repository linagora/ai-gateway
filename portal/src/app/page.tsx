import Link from "next/link";
import { requireUser } from "@/lib/session";

export default async function HomePage() {
  const user = await requireUser();
  return (
    <>
      <h1>Bonjour {user.name}</h1>
      <p>
        Ce portail donne accès aux modèles d&apos;IA de Linagora par une API compatible OpenAI. Chaque clé d&apos;API est
        validée par un administrateur et limitée aux modèles compatibles avec le niveau de sensibilité de vos données.
      </p>
      <ul className="mt-4 list-disc pl-6">
        <li>
          <Link href="/catalogue">Consulter le catalogue des modèles</Link>
        </li>
        <li>
          <Link href="/demandes/nouvelle">Demander une clé d&apos;API</Link>
        </li>
        <li>
          <Link href="/demandes">Suivre mes demandes</Link>
        </li>
        {user.isAdmin && (
          <li>
            <Link href="/gestion/demandes">Valider les demandes (administrateurs)</Link>
          </li>
        )}
      </ul>
    </>
  );
}
