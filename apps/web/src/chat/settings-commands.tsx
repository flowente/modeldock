import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type Account, type QuickCommand } from "./chat-api.ts";
import { Card, Feedback, Heading } from "./Settings.tsx";

export function CommandsSection({ account }: { account: Account }) {
  const isAdmin = account.role === "admin";
  const queryClient = useQueryClient();
  const commands = useQuery({ queryKey: ["quick-commands"], queryFn: api.commands });
  const [editing, setEditing] = useState<QuickCommand | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["quick-commands"] });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteCommand(id), onSuccess: refresh });

  const shared = (commands.data ?? []).filter((command) => command.shared);
  const own = (commands.data ?? []).filter((command) => !command.shared);

  return (
    <>
      <Heading
        title="Comandi rapidi"
        text="Istruzioni salvate da richiamare in chat scrivendo / all'inizio del messaggio: per esempio «/riassumi» seguito dal testo. Valgono per quel messaggio soltanto, con qualunque modello."
      />
      <CommandForm
        key={editing?.id ?? "new"}
        editing={editing}
        canShare={isAdmin}
        onDone={async () => {
          setEditing(null);
          await refresh();
        }}
        onCancel={() => setEditing(null)}
      />
      <Feedback error={commands.error ?? remove.error} />
      <Card title="I tuoi comandi" text="Li vedi e li usi solo tu.">
        <CommandList commands={own} empty="Non hai ancora comandi tuoi." onEdit={setEditing} onDelete={(command) => confirmDelete(command, remove.mutate)} />
      </Card>
      <Card title="Comandi condivisi" text={isAdmin ? "Disponibili per tutti gli account. Solo gli amministratori li modificano." : "Disponibili per tutti, li gestisce l'amministratore."}>
        <CommandList commands={shared} empty="Nessun comando condiviso." onEdit={setEditing} onDelete={(command) => confirmDelete(command, remove.mutate)} />
      </Card>
    </>
  );
}

function confirmDelete(command: QuickCommand, remove: (id: string) => void) {
  const who = command.shared ? " Sparirà per tutti gli account." : "";
  if (window.confirm(`Eliminare il comando /${command.name}?${who}`)) remove(command.id);
}

function CommandList({
  commands,
  empty,
  onEdit,
  onDelete
}: {
  commands: QuickCommand[];
  empty: string;
  onEdit: (command: QuickCommand) => void;
  onDelete: (command: QuickCommand) => void;
}) {
  if (commands.length === 0) return <p className="md-muted">{empty}</p>;
  return (
    <ul className="md-command-list">
      {commands.map((command) => (
        <li key={command.id}>
          <div className="md-command-text">
            <span className="md-slash-name">/{command.name}</span>
            {command.description ? <span className="md-muted">{command.description}</span> : null}
            <details>
              <summary>Istruzione</summary>
              <p>{command.instruction}</p>
            </details>
          </div>
          {command.editable ? (
            <div className="md-command-actions">
              <button type="button" className="md-ghost md-icon-button" aria-label={`Modifica /${command.name}`} onClick={() => onEdit(command)}>
                <Pencil size={16} aria-hidden="true" />
              </button>
              <button type="button" className="md-ghost md-icon-button" aria-label={`Elimina /${command.name}`} onClick={() => onDelete(command)}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CommandForm({
  editing,
  canShare,
  onDone,
  onCancel
}: {
  editing: QuickCommand | null;
  canShare: boolean;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [instruction, setInstruction] = useState(editing?.instruction ?? "");
  const [shared, setShared] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      editing ? api.updateCommand(editing.id, { name, description, instruction }) : api.createCommand({ name, description, instruction, shared }),
    onSuccess: async () => {
      setName("");
      setDescription("");
      setInstruction("");
      setShared(false);
      await onDone();
    }
  });

  return (
    <Card
      title={editing ? `Modifica /${editing.name}` : "Nuovo comando"}
      text="Scrivi l'istruzione come la daresti a una persona: cosa fare con il testo che seguirà il comando."
    >
      <form
        className="md-stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="md-inline-form">
          <label className="md-field" style={{ flex: "0 1 220px" }}>
            Nome
            <input
              value={name}
              onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9-/]/g, "-"))}
              placeholder="es. verbale"
              required
              maxLength={33}
            />
          </label>
          <label className="md-field" style={{ flex: "1 1 280px" }}>
            Descrizione (facoltativa)
            <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={120} placeholder="Cosa fa, in poche parole" />
          </label>
        </div>
        <label className="md-field">
          Istruzione
          <textarea
            className="md-textarea"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={4}
            maxLength={4000}
            required
            placeholder="es. Trasforma gli appunti che seguono in un verbale di riunione: partecipanti, decisioni, prossimi passi."
          />
        </label>
        {canShare && !editing ? (
          <label className="md-check">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
            <span>Condiviso: disponibile per tutti gli account</span>
          </label>
        ) : null}
        <Feedback error={save.error} />
        <div className="md-inline-form">
          <button type="submit" className="md-primary" disabled={save.isPending}>
            {editing ? "Salva" : "Crea il comando"}
          </button>
          {editing ? (
            <button type="button" className="md-outline" onClick={onCancel}>
              Annulla
            </button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
