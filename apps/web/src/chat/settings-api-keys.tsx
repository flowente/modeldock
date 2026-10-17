import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { api, type Account, type ApiKeySummary } from "./chat-api.ts";
import { CopyButton, copyText } from "./markdown.tsx";
import { Card, Feedback, formatDate, Heading } from "./Settings.tsx";
import { formatCount, KeyUsage } from "./settings-api-usage.tsx";

export function ApiKeysSection({ account, detail }: { account: Account; detail?: string }) {
  if (detail) return <KeyUsage id={detail} />;
  return <KeysOverview account={account} />;
}

function KeysOverview({ account }: { account: Account }) {
  const isAdmin = account.role === "admin";
  const [scope, setScope] = useState<"own" | "all">("own");
  const [secret, setSecret] = useState<string | null>(null);
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
      <CreateKeyCard
        onCreated={async (created) => {
          setSecret(created);
          await refresh();
        }}
        secret={secret}
      />

      <Card
        title={scope === "all" ? "Le chiavi di tutti gli account" : "Le tue chiavi"}
        text="Apri una chiave per vedere chiamate e token giorno per giorno. Revocane una che non usi più: smette di funzionare subito."
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
        <KeyTable
          keys={keys.data ?? []}
          loading={keys.isPending}
          showOwner={scope === "all"}
          onRevoke={(key) => {
            if (window.confirm(`Revocare la chiave "${key.name}"? Gli script che la usano smetteranno di funzionare.`)) revoke.mutate(key.id);
          }}
        />
      </Card>

      <ConnectCard account={account} secret={secret} />
    </>
  );
}

function CreateKeyCard({ onCreated, secret }: { onCreated: (secret: string) => Promise<void>; secret: string | null }) {
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.createApiKey(name),
    onSuccess: async (result) => {
      setCopied(false);
      setName("");
      await onCreated(result.secret);
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
            come una password. Negli esempi qui sotto è già inserita.
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
            <th scope="col" className="md-right">
              Chiamate (30 gg)
            </th>
            <th scope="col" className="md-right">
              Token (30 gg)
            </th>
            <th scope="col">Ultimo uso</th>
            <th scope="col">
              <span className="md-sr-only">Azioni</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id}>
              <td>
                <a className="md-key-link" href={`#/impostazioni/chiavi-api/${encodeURIComponent(key.id)}`}>
                  {key.name}
                  <ChevronRight size={14} aria-hidden="true" />
                </a>
                <small className="md-muted md-key-created">creata {formatDate(key.createdAt)}</small>
              </td>
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
              <td className="md-right md-num">{formatCount(key.usage.calls)}</td>
              <td className="md-right md-num">{formatCount(key.usage.promptTokens + key.usage.completionTokens)}</td>
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

/* ---------------------------------------------------------------- How to connect */

type Language = "curl" | "python" | "javascript" | "n8n";

const LANGUAGES: Array<{ id: Language; label: string }> = [
  { id: "curl", label: "curl" },
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "n8n", label: "n8n" }
];

function ConnectCard({ account, secret }: { account: Account; secret: string | null }) {
  const [language, setLanguage] = useState<Language>("python");
  const models = useQuery({ queryKey: ["chat-models"], queryFn: api.models });
  // Only administrators can read the network addresses; for the others the current one will do.
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, retry: false, enabled: account.role === "admin" });
  const onThisComputer = ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);
  const network = devices.data?.connection.hosts[0];
  const networkUrl = onThisComputer ? (network ? `https://${network.host}:${network.port}/v1` : null) : `${window.location.origin}/v1`;
  const localUrl = `${onThisComputer ? window.location.origin : "http://127.0.0.1:4317"}/v1`;
  const key = secret ?? "LA_TUA_CHIAVE";
  // The lightest model answers fastest: the right one for a first try.
  const model = [...(models.data ?? [])].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]?.name ?? "nome-del-modello";

  return (
    <Card title="Come collegarsi" text="Qualsiasi programma che sa usare OpenAI funziona con ModelDock: cambi solo l'indirizzo e la chiave.">
      <dl className="md-connect-list">
        <div>
          <dt>Da questo computer</dt>
          <dd>
            <code>{localUrl}</code>
            <CopyButton text={localUrl} compact label="Copia l'indirizzo" />
          </dd>
        </div>
        <div>
          <dt>Da un altro computer con ModelDock Link</dt>
          <dd>
            <code>http://127.0.0.1:4320/v1</code>
            <CopyButton text="http://127.0.0.1:4320/v1" compact label="Copia l'indirizzo" />
            <small>ModelDock Link fa da tramite e verifica lui il certificato. È la strada consigliata.</small>
          </dd>
        </div>
        {networkUrl ? (
          <div>
            <dt>Dalla rete di casa, senza ModelDock Link</dt>
            <dd>
              <code>{networkUrl}</code>
              <CopyButton text={networkUrl} compact label="Copia l'indirizzo" />
              <small>Il certificato è di ModelDock e i programmi non lo conoscono: va accettato a mano (in curl con -k). Usala solo per provare.</small>
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="md-segmented" role="group" aria-label="Linguaggio dell'esempio">
        {LANGUAGES.map((candidate) => (
          <button key={candidate.id} type="button" aria-pressed={language === candidate.id} onClick={() => setLanguage(candidate.id)}>
            {candidate.label}
          </button>
        ))}
      </div>
      <Example language={language} baseUrl={localUrl} apiKey={key} model={model} />
      {!secret ? <p className="md-muted">Sostituisci LA_TUA_CHIAVE con una chiave creata qui sopra.</p> : null}
    </Card>
  );
}

function Example({ language, baseUrl, apiKey, model }: { language: Language; baseUrl: string; apiKey: string; model: string }) {
  const code = exampleCode(language, baseUrl, apiKey, model);
  return (
    <div className="md-code">
      <div className="md-code-header">
        {language === "n8n" ? "n8n" : language}
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function exampleCode(language: Language, baseUrl: string, apiKey: string, model: string): string {
  switch (language) {
    case "curl":
      return [
        `curl ${baseUrl}/chat/completions \\`,
        `  -H "Authorization: Bearer ${apiKey}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Ciao!"}]}'`
      ].join("\n");
    case "python":
      return [
        "# pip install openai",
        "from openai import OpenAI",
        "",
        `client = OpenAI(base_url="${baseUrl}", api_key="${apiKey}")`,
        "",
        "risposta = client.chat.completions.create(",
        `    model="${model}",`,
        '    messages=[{"role": "user", "content": "Ciao!"}],',
        ")",
        "print(risposta.choices[0].message.content)"
      ].join("\n");
    case "javascript":
      return [
        "// npm install openai",
        'import OpenAI from "openai";',
        "",
        `const client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "${apiKey}" });`,
        "",
        "const risposta = await client.chat.completions.create({",
        `  model: "${model}",`,
        '  messages: [{ role: "user", content: "Ciao!" }],',
        "});",
        "console.log(risposta.choices[0].message.content);"
      ].join("\n");
    case "n8n":
      return [
        "1. Credentials → New → OpenAI",
        `2. API Key:  ${apiKey}`,
        `3. Base URL: ${baseUrl}`,
        `4. Nel nodo OpenAI (o "OpenAI Chat Model") scegli il modello: ${model}`,
        "",
        "n8n deve girare su questo computer, fuori da Docker: dentro un",
        "contenitore 127.0.0.1 indica il contenitore stesso. Un n8n su",
        "internet non può raggiungere ModelDock, ed è voluto."
      ].join("\n");
  }
}
