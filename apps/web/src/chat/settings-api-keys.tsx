import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { api, type Account, type ApiKeySummary } from "./chat-api.ts";
import { copyText } from "./markdown.tsx";
import { Card, Feedback, formatDate, Heading } from "./Settings.tsx";

export function ApiKeysSection({ account }: { account: Account }) {
  const isAdmin = account.role === "admin";
  const [scope, setScope] = useState<"own" | "all">("own");
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys", scope], queryFn: () => api.apiKeys(scope) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["api-keys"] });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeApiKey(id), onSuccess: refresh });

  return (
    <>
      <Heading
        title="Chiavi API"
        text="Per usare i modelli di ModelDock da script e programmi che parlano come OpenAI. Una chiave può fare con i modelli esattamente quello che può fare il suo account, niente di più."
      />
      <CreateKeyCard onCreated={refresh} />

      <Card
        title={scope === "all" ? "Le chiavi di tutti gli account" : "Le tue chiavi"}
        text="Revoca una chiave che non usi più o che potrebbe essere finita nelle mani sbagliate: smette di funzionare subito."
      >
        {isAdmin ? (
          <div className="md-segmented" role="group" aria-label="Quali chiavi mostrare">
            <button type="button" aria-pressed={scope === "own"} onClick={() => setScope("own")}>
              Le mie
            </button>
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              Tutti gli account
            </button>
          </div>
        ) : null}
        <Feedback error={keys.error ?? revoke.error} />
        <KeyTable keys={keys.data ?? []} loading={keys.isPending} showOwner={scope === "all"} onRevoke={(key) => {
          if (window.confirm(`Revocare la chiave "${key.name}"? Gli script che la usano smetteranno di funzionare.`)) revoke.mutate(key.id);
        }} />
      </Card>
    </>
  );
}

function CreateKeyCard({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.createApiKey(name),
    onSuccess: async (result) => {
      setSecret(result.secret);
      setCopied(false);
      setName("");
      await onCreated();
    }
  });

  return (
    <Card title="Crea una chiave" text="Dagli un nome che ti ricordi dove la usi, per esempio «n8n» o «script fatture».">
      <form
        className="md-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label className="md-field" style={{ flex: "1 1 260px" }}>
          Nome
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} />
        </label>
        <button type="submit" className="md-primary" disabled={create.isPending}>
          Crea la chiave
        </button>
      </form>
      <Feedback error={create.error} />
      {secret ? (
        <div className="md-invite-result">
          <p>
            <strong>Copiala adesso: non la vedrai più.</strong> ModelDock ne conserva solo un'impronta, quindi se la perdi devi crearne una nuova. Trattala
            come una password.
          </p>
          <div className="md-copy-row">
            <code>{secret}</code>
            <button
              type="button"
              className="md-outline"
              onClick={async () => {
                if (await copyText(secret)) setCopied(true);
              }}
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copied ? "Copiata" : "Copia"}
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function KeyTable({ keys, loading, showOwner, onRevoke }: { keys: ApiKeySummary[]; loading: boolean; showOwner: boolean; onRevoke: (key: ApiKeySummary) => void }) {
  if (loading) return <p className="md-muted">Caricamento…</p>;
  if (keys.length === 0) {
    return (
      <p className="md-muted md-empty-keys">
        <KeyRound size={16} aria-hidden="true" />
        {showOwner ? "Nessun account ha chiavi attive." : "Non hai ancora nessuna chiave."}
      </p>
    );
  }
  return (
    <div className="md-table-scroll">
      <table className="md-table">
        <thead>
          <tr>
            <th scope="col">Nome</th>
            {showOwner ? <th scope="col">Account</th> : null}
            <th scope="col">Chiave</th>
            <th scope="col">Creata</th>
            <th scope="col">Ultimo uso</th>
            <th scope="col">
              <span className="md-sr-only">Azioni</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id}>
              <td>{key.name}</td>
              {showOwner ? (
                <td>
                  <div className="md-person">
                    <span>{key.owner.displayName}</span>
                    <small>{key.owner.email}</small>
                  </div>
                </td>
              ) : null}
              <td>
                <code className="md-key-hint">{key.hint}</code>
              </td>
              <td>{formatDate(key.createdAt)}</td>
              <td>{key.lastUsedAt ? formatDate(key.lastUsedAt) : <span className="md-muted">Mai</span>}</td>
              <td className="md-right">
                <button type="button" className="md-outline" onClick={() => onRevoke(key)} aria-label={`Revoca la chiave ${key.name}`}>
                  Revoca
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
