import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ProjectView } from "./chat-api.ts";
import { explain } from "./ChatApp.tsx";

/**
 * Starting a project from the chat: name, description and instructions are enough to begin.
 * References, files and sharing stay in the settings, one click away.
 */
export function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (project: ProjectView) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  // The browser's own modal: focus stays inside, Escape closes it.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.createProject({ name, description, instructions, reference: "", model: "" }),
    onSuccess: async (project) => {
      setName("");
      setDescription("");
      setInstructions("");
      await onCreated(project);
    }
  });

  return (
    <dialog ref={ref} className="md-dialog" onClose={onClose} aria-labelledby="md-new-project-title">
      <form
        className="md-stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="md-dialog-head">
          <h2 id="md-new-project-title">Nuovo progetto</h2>
          <button type="button" className="md-ghost md-icon-button" aria-label="Chiudi" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="md-muted">Le chat che inizierai qui dentro seguiranno queste istruzioni. Testi di riferimento, file e condivisione si aggiungono dopo, dalle impostazioni.</p>
        <label className="md-field">
          Nome
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} placeholder="es. Flowente – brand" autoFocus />
        </label>
        <label className="md-field">
          Descrizione (facoltativa)
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={160} placeholder="A cosa serve, in una riga" />
        </label>
        <label className="md-field">
          Istruzioni
          <textarea
            className="md-dialog-textarea"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={6}
            maxLength={20_000}
            placeholder={"es. Rispondi in italiano, con tono calmo e concreto, dando del tu.\nSe non sai una cosa, dillo invece di inventare."}
          />
        </label>
        {create.error ? (
          <div className="md-form-error" role="alert">
            {explain(create.error)}
          </div>
        ) : null}
        <div className="md-dialog-actions">
          <button type="button" className="md-outline" onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className="md-primary" disabled={create.isPending || !name.trim()}>
            Crea e apri
          </button>
        </div>
      </form>
    </dialog>
  );
}
