import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus, Folder, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, type Account, type ProjectInput, type ProjectSummary, type ProjectView } from "./chat-api.ts";
import { Markdown } from "./markdown.tsx";
import { Card, Feedback, Heading } from "./Settings.tsx";

const LIMITS = { name: 60, description: 160, instructions: 20_000, reference: 60_000 };
/** What Ollama gives a model when nothing else is set (measured on this machine, 19 Oct 2026). */
const OLLAMA_DEFAULT_CONTEXT = 4096;
/** Roughly, for Italian and English text. Ollama counts exactly only once the model reads it. */
const CHARS_PER_TOKEN = 3.5;

export function ProjectsSection({ account, openId }: { account: Account; /** A project to open for editing, from the chat. */ openId?: string }) {
  const isAdmin = account.role === "admin";
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects-manage"], queryFn: api.projectsToManage });
  const [editingId, setEditingId] = useState<string | null>(openId ?? null);
  const [formKey, setFormKey] = useState(0);
  const editing = useQuery({ queryKey: ["project", editingId], queryFn: () => api.project(editingId!), enabled: Boolean(editingId) });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects-manage"] });
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
  };
  const remove = useMutation({ mutationFn: (id: string) => api.deleteProject(id), onSuccess: refresh });
  const reset = () => {
    setEditingId(null);
    setFormKey((key) => key + 1);
  };

  return (
    <>
      <Heading
        title="Progetti"
        text="Istruzioni e testi di riferimento che valgono per tutta una conversazione. Scegli il progetto nella barra laterale della chat: ogni chat nuova parte lì dentro. Il contesto si condivide, le conversazioni restano di chi le fa."
      />
      {editingId && !editing.data ? (
        <p className="md-muted">Caricamento…</p>
      ) : (
        <ProjectForm
          key={`${formKey}-${editing.data?.id ?? "new"}`}
          {...(editingId && editing.data ? { editing: editing.data } : {})}
          isAdmin={isAdmin}
          accountId={account.id}
          onDone={async () => {
            reset();
            await refresh();
          }}
          onCancel={reset}
        />
      )}
      <Feedback error={projects.error ?? remove.error ?? editing.error} />
      <Card title={isAdmin ? "Tutti i progetti" : "I tuoi progetti e quelli condivisi con te"}>
        <ProjectList
          projects={projects.data ?? []}
          onEdit={(id) => {
            setEditingId(id);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onDelete={(project) => {
            if (window.confirm(`Eliminare il progetto «${project.name}»? Le sue conversazioni restano, senza il progetto.`)) remove.mutate(project.id);
          }}
        />
      </Card>
    </>
  );
}

function ProjectList({ projects, onEdit, onDelete }: { projects: ProjectSummary[]; onEdit: (id: string) => void; onDelete: (project: ProjectSummary) => void }) {
  if (projects.length === 0) return <p className="md-muted">Ancora nessun progetto.</p>;
  return (
    <ul className="md-command-list">
      {projects.map((project) => (
        <li key={project.id}>
          <div className="md-command-text">
            <span className="md-project-name">
              <Folder size={15} aria-hidden="true" />
              {project.name}
            </span>
            {project.description ? <span className="md-muted">{project.description}</span> : null}
            <span className="md-muted md-small">
              di {project.owner.displayName || "—"} · {project.shared ? "condiviso" : "personale"} · circa {formatTokens(project.contextChars)} token
              {project.model ? ` · ${project.model}` : ""}
            </span>
          </div>
          {project.editable ? (
            <div className="md-command-actions">
              <button type="button" className="md-ghost md-icon-button" aria-label={`Modifica ${project.name}`} onClick={() => onEdit(project.id)}>
                <Pencil size={16} aria-hidden="true" />
              </button>
              <button type="button" className="md-ghost md-icon-button" aria-label={`Elimina ${project.name}`} onClick={() => onDelete(project)}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function formatTokens(chars: number): string {
  return Math.ceil(chars / CHARS_PER_TOKEN).toLocaleString("it-IT");
}

function ProjectForm({
  editing,
  isAdmin,
  accountId,
  onDone,
  onCancel
}: {
  editing?: ProjectView;
  isAdmin: boolean;
  /** Who is filling in the form: the owner of a new project, so not in the list of others. */
  accountId: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const models = useQuery({ queryKey: ["chat-models"], queryFn: api.models });
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: isAdmin });
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups, enabled: isAdmin });
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [model, setModel] = useState(editing?.model ?? "");
  const [instructions, setInstructions] = useState(editing?.instructions ?? "");
  const [reference, setReference] = useState(editing?.reference ?? "");
  const [access, setAccess] = useState(editing?.access ?? []);

  const save = useMutation({
    mutationFn: () => {
      const body: ProjectInput = { name, description, instructions, reference, model, ...(isAdmin ? { access } : {}) };
      return editing ? api.updateProject(editing.id, body) : api.createProject(body);
    },
    onSuccess: onDone
  });

  const toggle = (type: "user" | "group", id: string, on: boolean) =>
    setAccess((current) => (on ? [...current, { type, id }] : current.filter((subject) => !(subject.type === type && subject.id === id))));
  const has = (type: "user" | "group", id: string) => access.some((subject) => subject.type === type && subject.id === id);

  const chosen = models.data?.find((candidate) => candidate.name === model);
  const context = chosen?.contextLength ?? OLLAMA_DEFAULT_CONTEXT;
  const tokens = Math.ceil((instructions.length + reference.length) / CHARS_PER_TOKEN);
  const share = tokens / context;

  return (
    <Card
      title={editing ? `Modifica «${editing.name}»` : "Nuovo progetto"}
      text="Le istruzioni dicono come comportarsi; i testi di riferimento sono il materiale che il modello legge sempre (note, listini, glossari)."
    >
      <form
        className="md-stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="md-inline-form">
          <label className="md-field" style={{ flex: "1 1 240px" }}>
            Nome
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={LIMITS.name} placeholder="es. Flowente – brand" />
          </label>
          <label className="md-field" style={{ flex: "1 1 220px" }}>
            Modello consigliato (facoltativo)
            <select className="md-select" value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">Nessuno: quello scelto in chat</option>
              {(models.data ?? []).map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="md-field">
          Descrizione (facoltativa)
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={LIMITS.description} placeholder="A cosa serve, in una riga" />
        </label>

        <MarkdownField
          label="Istruzioni"
          value={instructions}
          onChange={setInstructions}
          max={LIMITS.instructions}
          placeholder={"es.\nSei l'assistente di Flowente. Rispondi in italiano, con tono calmo e concreto, dando del tu.\nSe una cosa non è nei testi di riferimento, dillo invece di inventare."}
        />
        <MarkdownField
          label="Testi di riferimento"
          value={reference}
          onChange={setReference}
          max={LIMITS.reference}
          canAddFiles
          placeholder={"es.\n## Listino\n- AI Pilota: …\n\n## Glossario\n- Flow Marks: …"}
        />

        <div className="md-context-meter" data-level={share > 0.9 ? "over" : share > 0.6 ? "high" : "ok"}>
          <div className="md-context-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, share * 100)}%` }} />
          </div>
          <small>
            Il progetto occupa circa <strong>{tokens.toLocaleString("it-IT")} token</strong> su {context.toLocaleString("it-IT")} che il modello legge in una volta
            {chosen?.contextLength ? "" : " (il valore normale di Ollama; quello vero si vede quando il modello è in memoria)"}.
            {share > 0.9
              ? " Non ci sta: il modello taglierebbe l'inizio, dove ci sono le istruzioni. Accorcia i testi o aumenta il contesto di Ollama."
              : share > 0.6
                ? " Resta poco spazio per la conversazione: le chat lunghe perderanno l'inizio."
                : ""}
          </small>
        </div>

        {isAdmin ? (
          <fieldset className="md-chip-list">
            <legend className="md-eyebrow">Chi può usarlo, oltre a te</legend>
            {(groups.data ?? []).map((group) => (
              <label key={group.id} className="md-chip">
                <input type="checkbox" checked={has("group", group.id)} onChange={(event) => toggle("group", group.id, event.target.checked)} />
                Gruppo {group.name}
              </label>
            ))}
            {(users.data ?? [])
              .filter((user) => user.id !== (editing?.owner.id ?? accountId))
              .map((user) => (
                <label key={user.id} className="md-chip">
                  <input type="checkbox" checked={has("user", user.id)} onChange={(event) => toggle("user", user.id, event.target.checked)} />
                  {user.displayName}
                </label>
              ))}
            {(groups.data ?? []).length === 0 && (users.data ?? []).length <= 1 ? <span className="md-muted">Ancora nessun altro account: invita qualcuno da Utenti e gruppi.</span> : null}
          </fieldset>
        ) : (
          <p className="md-muted md-small">Il progetto è personale: per condividerlo con altri chiedi a un amministratore.</p>
        )}

        <Feedback error={save.error} />
        <div className="md-inline-form">
          <button type="submit" className="md-primary" disabled={save.isPending}>
            {editing ? "Salva" : "Crea il progetto"}
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

/** A Markdown text area with a preview, and optionally files (.md, .txt) appended to it. */
function MarkdownField(props: { label: string; value: string; onChange: (value: string) => void; max: number; placeholder: string; canAddFiles?: boolean }) {
  const [preview, setPreview] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    setFileError(null);
    let next = props.value;
    for (const file of [...(files ?? [])]) {
      if (file.size > 500_000) {
        setFileError(`${file.name} è troppo grande: i file lunghi andranno nei documenti del progetto.`);
        continue;
      }
      const text = (await file.text()).replace(/^﻿/, "").trim();
      next = `${next.trim()}${next.trim() ? "\n\n" : ""}## ${file.name.replace(/\.(md|markdown|txt)$/i, "")}\n\n${text}`;
    }
    props.onChange(next.slice(0, props.max));
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="md-field">
      <div className="md-skill-editor-bar">
        <span>{props.label}</span>
        <div className="md-inline-form" style={{ gap: 8 }}>
          {props.canAddFiles ? (
            <>
              <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden onChange={(event) => void addFiles(event.target.files)} />
              <button type="button" className="md-ghost md-small-button" onClick={() => fileRef.current?.click()}>
                <FilePlus size={15} aria-hidden="true" />
                Aggiungi da file
              </button>
            </>
          ) : null}
          <div className="md-segmented" role="group" aria-label={`${props.label}: modalità`}>
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Scrivi
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Anteprima
            </button>
          </div>
        </div>
      </div>
      {preview ? (
        <div className="md-skill-preview md-skill-preview-box">{props.value.trim() ? <Markdown text={props.value} /> : <p className="md-muted">Niente da mostrare.</p>}</div>
      ) : (
        <textarea
          className="md-textarea md-skill-source"
          aria-label={props.label}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          rows={8}
          maxLength={props.max}
          placeholder={props.placeholder}
        />
      )}
      {fileError ? (
        <p className="md-form-error" role="alert">
          {fileError}
        </p>
      ) : null}
      <small>
        {props.value.length.toLocaleString("it-IT")} / {props.max.toLocaleString("it-IT")} caratteri
      </small>
    </div>
  );
}
