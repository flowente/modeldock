import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, type Account, type QuickCommand } from "./chat-api.ts";
import { Markdown } from "./markdown.tsx";
import { Card, Feedback, Heading } from "./Settings.tsx";
import { MAX_DESCRIPTION, MAX_INSTRUCTION, parseSkillMarkdown, toSkillMarkdown, toSkillName, type SkillFields } from "./skill-markdown.ts";

/** Over this, small models start to have little room left for the text they work on. */
const LONG_SKILL = 6000;

export function CommandsSection({ account }: { account: Account }) {
  const isAdmin = account.role === "admin";
  const queryClient = useQueryClient();
  const commands = useQuery({ queryKey: ["quick-commands"], queryFn: api.commands });
  // What the form shows: a skill being edited, a file just imported, or nothing (a new one).
  const [draft, setDraft] = useState<{ editing?: QuickCommand; fields?: SkillFields; key: number }>({ key: 0 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["quick-commands"] });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteCommand(id), onSuccess: refresh });

  const shared = (commands.data ?? []).filter((command) => command.shared);
  const own = (commands.data ?? []).filter((command) => !command.shared);
  const edit = (command: QuickCommand) => {
    setDraft({ editing: command, key: Date.now() });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const lists = { onEdit: edit, onDelete: (command: QuickCommand) => confirmDelete(command, remove.mutate) };

  return (
    <>
      <Heading
        title="Skill"
        text="Istruzioni salvate da richiamare in chat scrivendo / e il loro nome, per esempio «/riassumi» seguito dal testo. Puoi scriverle in Markdown e importarle da un file .md, nello stesso formato delle skill di altri assistenti."
      />
      <SkillForm
        key={draft.key}
        {...(draft.editing ? { editing: draft.editing } : {})}
        {...(draft.fields ? { imported: draft.fields } : {})}
        canShare={isAdmin}
        onImport={(fields) => setDraft({ fields, key: Date.now() })}
        onDone={async () => {
          setDraft({ key: Date.now() });
          await refresh();
        }}
        onCancel={() => setDraft({ key: Date.now() })}
      />
      <Feedback error={commands.error ?? remove.error} />
      <Card title="Le tue skill" text="Le vedi e le usi solo tu.">
        <SkillList commands={own} empty="Non hai ancora skill tue." {...lists} />
      </Card>
      <Card title="Skill condivise" text={isAdmin ? "Disponibili per tutti gli account. Solo gli amministratori le modificano." : "Disponibili per tutti, le gestisce l'amministratore."}>
        <SkillList commands={shared} empty="Nessuna skill condivisa." {...lists} />
      </Card>
    </>
  );
}

function confirmDelete(command: QuickCommand, remove: (id: string) => void) {
  const who = command.shared ? " Sparirà per tutti gli account." : "";
  if (window.confirm(`Eliminare la skill /${command.name}?${who}`)) remove(command.id);
}

/** Saves the skill as a .md file, readable here and by other assistants. */
function download(command: QuickCommand) {
  const blob = new Blob([toSkillMarkdown(command)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${command.name}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function SkillList({
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
              <summary>Istruzioni</summary>
              <div className="md-skill-preview">
                <Markdown text={command.instruction} />
              </div>
            </details>
          </div>
          <div className="md-command-actions">
            <button type="button" className="md-ghost md-icon-button" aria-label={`Scarica /${command.name} come file .md`} onClick={() => download(command)}>
              <Download size={16} aria-hidden="true" />
            </button>
            {command.editable ? (
              <>
                <button type="button" className="md-ghost md-icon-button" aria-label={`Modifica /${command.name}`} onClick={() => onEdit(command)}>
                  <Pencil size={16} aria-hidden="true" />
                </button>
                <button type="button" className="md-ghost md-icon-button" aria-label={`Elimina /${command.name}`} onClick={() => onDelete(command)}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SkillForm({
  editing,
  imported,
  canShare,
  onImport,
  onDone,
  onCancel
}: {
  editing?: QuickCommand;
  imported?: SkillFields;
  canShare: boolean;
  onImport: (fields: SkillFields) => void;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const start = editing ?? imported;
  const [name, setName] = useState(start?.name ?? "");
  const [description, setDescription] = useState(start?.description ?? "");
  const [instruction, setInstruction] = useState(start?.instruction ?? "");
  const [shared, setShared] = useState(false);
  const [preview, setPreview] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: () =>
      editing ? api.updateCommand(editing.id, { name, description, instruction }) : api.createCommand({ name, description, instruction, shared }),
    onSuccess: onDone
  });

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    if (file.size > 200_000) {
      setImportError("Il file è troppo grande per essere una skill.");
      return;
    }
    const fields = parseSkillMarkdown(await file.text(), file.name);
    if (!fields.instruction) {
      setImportError("Il file non contiene istruzioni.");
      return;
    }
    onImport(fields);
  };

  return (
    <Card
      title={editing ? `Modifica /${editing.name}` : imported ? "Skill importata: controlla e salva" : "Nuova skill"}
      text="Scrivi le istruzioni come le daresti a una persona: cosa fare con il testo che seguirà il nome della skill. Il Markdown va benissimo."
    >
      {!editing ? (
        <div>
          <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(event) => void readFile(event.target.files?.[0])} />
          <button type="button" className="md-outline" onClick={() => fileRef.current?.click()}>
            <Upload size={16} aria-hidden="true" />
            Importa da un file .md
          </button>
          {importError ? (
            <p className="md-form-error" role="alert">
              {importError}
            </p>
          ) : null}
        </div>
      ) : null}
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
            <input value={name} onChange={(event) => setName(toSkillName(event.target.value) + (event.target.value.endsWith("-") || event.target.value.endsWith(" ") ? "-" : ""))} placeholder="es. verbale" required maxLength={32} />
          </label>
          <label className="md-field" style={{ flex: "1 1 280px" }}>
            Descrizione (facoltativa)
            <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={MAX_DESCRIPTION} placeholder="Cosa fa, in poche parole" />
          </label>
        </div>
        <div className="md-field">
          <div className="md-skill-editor-bar">
            <span>Istruzioni</span>
            <div className="md-segmented" role="group" aria-label="Modalità">
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                Scrivi
              </button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                Anteprima
              </button>
            </div>
          </div>
          {preview ? (
            <div className="md-skill-preview md-skill-preview-box">{instruction.trim() ? <Markdown text={instruction} /> : <p className="md-muted">Niente da mostrare.</p>}</div>
          ) : (
            <textarea
              className="md-textarea md-skill-source"
              aria-label="Istruzioni"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              rows={10}
              maxLength={MAX_INSTRUCTION}
              required
              placeholder={"es.\n# Verbale di riunione\n\nTrasforma gli appunti che seguono in un verbale:\n- **Partecipanti**\n- **Decisioni**\n- **Prossimi passi**, con chi e entro quando"}
            />
          )}
          <small className={instruction.length > LONG_SKILL ? "md-skill-warning" : undefined}>
            {instruction.length.toLocaleString("it-IT")} / {MAX_INSTRUCTION.toLocaleString("it-IT")} caratteri
            {instruction.length > LONG_SKILL ? " · una skill lunga lascia meno spazio al testo: con i modelli piccoli può essere tagliata" : ""}
          </small>
        </div>
        {canShare && !editing ? (
          <label className="md-check">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
            <span>Condivisa: disponibile per tutti gli account</span>
          </label>
        ) : null}
        <Feedback error={save.error} />
        <div className="md-inline-form">
          <button type="submit" className="md-primary" disabled={save.isPending}>
            {editing ? "Salva" : "Crea la skill"}
          </button>
          {editing || imported ? (
            <button type="button" className="md-outline" onClick={onCancel}>
              Annulla
            </button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
