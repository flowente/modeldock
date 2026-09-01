import type { AccessGroup, Model, ModelAccessPolicy, ModelPullJob, SystemResources } from "../api.js";
import { formatBytes } from "../lib/format.js";
import { getModelFit } from "../lib/model-fit.js";
import { getPullPercentage } from "../lib/pull-jobs.js";
import type { LanguagePreference, ModelRuntimeAction, UpdateModelAccessInput } from "../types.js";
import { AccessCheckbox, SwitchToggle } from "./shared.js";

export function ModelAccessRow({
  groups,
  isDeleting,
  isUpdating,
  model,
  language,
  onDelete,
  onUpdate,
  policy,
  runtimeAction,
  resources
}: {
  groups: AccessGroup[];
  isDeleting: boolean;
  isUpdating: boolean;
  language: LanguagePreference;
  model: Model;
  onDelete(name: string): void;
  onUpdate(input: UpdateModelAccessInput): void;
  policy?: ModelAccessPolicy;
  runtimeAction: ModelRuntimeAction | null;
  resources?: SystemResources;
}) {
  const loaded = policy?.loaded ?? model.running;
  const enabled = policy?.enabled ?? true;
  const fit = getModelFit(model, resources, language);

  return (
    <tr>
      <td>
        <strong>{model.name}</strong>
        <span className="muted-copy">{model.tag}</span>
      </td>
      <td>
        <span className={`fit-label ${fit.tone}`} title={fit.title}>{fit.label}</span>
      </td>
      <td>
        {runtimeAction ? <RuntimeProgress action={runtimeAction} language={language} /> : <span className="size-value">{formatBytes(model.sizeBytes)}</span>}
      </td>
      <td className="control-cell">
        <SwitchToggle
          disabled={!policy || isUpdating}
          label={language === "it" ? `${model.name} ${loaded ? "è caricato in memoria" : "non è caricato in memoria"}` : `${model.name} is ${loaded ? "loaded in memory" : "not loaded in memory"}`}
          on={loaded}
          onClick={() => onUpdate({ modelName: model.name, loaded: !loaded })}
        />
      </td>
      <td className="control-cell">
        <SwitchToggle
          disabled={!policy || isUpdating}
          label={language === "it" ? `${model.name} è ${enabled ? "abilitato" : "disabilitato"}` : `${model.name} is ${enabled ? "enabled" : "disabled"}`}
          on={enabled}
          onClick={() => onUpdate({ modelName: model.name, enabled: !enabled })}
        />
      </td>
      {groups.map((group) => {
        const granted = isGroupGranted(policy, group.id);

        return (
          <td className="control-cell" key={group.id}>
            <AccessCheckbox
              checked={granted}
              description={group.description}
              label={language === "it" ? `${group.name} ${granted ? "può usare" : "non può usare"} ${model.name}` : `${group.name} ${granted ? "can use" : "cannot use"} ${model.name}`}
              disabled={!policy || isUpdating}
              onClick={() =>
                onUpdate({
                  modelName: model.name,
                  groupGrants: {
                    [group.id]: !granted
                  }
                })
              }
            />
          </td>
        );
      })}
      <td className="control-cell">
        <button className="danger-button" disabled={isDeleting} type="button" onClick={() => onDelete(model.name)}>
          {language === "it" ? "Elimina" : "Delete"}
        </button>
      </td>
    </tr>
  );
}

export function RuntimeProgress({ action, language }: { action: ModelRuntimeAction; language: LanguagePreference }) {
  const label = action === "loading"
    ? language === "it" ? "Caricamento…" : "Loading…"
    : language === "it" ? "Scaricamento…" : "Unloading…";

  return (
    <span className="runtime-progress" role="status" aria-live="polite">
      <span className="runtime-progress-label">{label}</span>
      <span className="runtime-progress-track" aria-hidden="true">
        <span />
      </span>
    </span>
  );
}

export function PullProgress({ job, language }: { job?: ModelPullJob; language: LanguagePreference }) {
  const percentage = getPullPercentage(job);
  const jobMessage = language === "it" ? translatePullMessage(job?.message) : job?.message;
  const label = job ? `${job.model}: ${jobMessage}` : language === "it" ? "Avvio del download…" : "Starting pull…";
  const failed = job?.status === "failed";

  return (
    <div className={`pull-progress ${failed ? "failed" : ""}`} role="status" aria-live="polite">
      <div className="pull-progress-copy">
        <span>{label}</span>
        {percentage !== null ? <strong>{percentage}%</strong> : null}
      </div>
      <div className={`pull-progress-track ${percentage === null && !failed ? "indeterminate" : ""}`}>
        <span style={percentage === null ? undefined : { width: `${percentage}%` }} />
      </div>
      {job?.error ? <p>{job.error}</p> : null}
    </div>
  );
}

function translatePullMessage(message: string | undefined): string {
  if (!message) return "Preparazione…";

  const normalized = message.toLowerCase();
  if (normalized.includes("pulling manifest")) return "Lettura del manifest";
  if (normalized.includes("downloading")) return "Download in corso";
  if (normalized.includes("verifying")) return "Verifica del download";
  if (normalized.includes("writing manifest")) return "Salvataggio del manifest";
  if (normalized === "success") return "Completato";
  return message;
}

function isGroupGranted(policy: ModelAccessPolicy | undefined, groupId: string): boolean {
  return (
    policy?.grants.some((grant) => grant.canUse && grant.subject.type === "group" && grant.subject.id === groupId) ?? false
  );
}
