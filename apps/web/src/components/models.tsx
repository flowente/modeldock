import type { AccessGroup, Model, ModelAccessPolicy, ModelPullJob, SystemResources } from "../api.js";
import { formatBytes } from "../lib/format.js";
import { getModelFit } from "../lib/model-fit.js";
import { getPullPercentage } from "../lib/pull-jobs.js";
import type { ModelRuntimeAction, UpdateModelAccessInput } from "../types.js";
import { AccessCheckbox, SwitchToggle } from "./shared.js";

export function ModelAccessRow({
  groups,
  isDeleting,
  isUpdating,
  model,
  onDelete,
  onUpdate,
  policy,
  runtimeAction,
  resources
}: {
  groups: AccessGroup[];
  isDeleting: boolean;
  isUpdating: boolean;
  model: Model;
  onDelete(name: string): void;
  onUpdate(input: UpdateModelAccessInput): void;
  policy?: ModelAccessPolicy;
  runtimeAction: ModelRuntimeAction | null;
  resources?: SystemResources;
}) {
  const loaded = policy?.loaded ?? model.running;
  const enabled = policy?.enabled ?? true;
  const fit = getModelFit(model, resources);

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
        {runtimeAction ? <RuntimeProgress action={runtimeAction} /> : <span className="size-value">{formatBytes(model.sizeBytes)}</span>}
      </td>
      <td className="control-cell">
        <SwitchToggle
          disabled={!policy || isUpdating}
          label={`${model.name} is ${loaded ? "loaded in memory" : "not loaded in memory"}`}
          on={loaded}
          onClick={() => onUpdate({ modelName: model.name, loaded: !loaded })}
        />
      </td>
      <td className="control-cell">
        <SwitchToggle
          disabled={!policy || isUpdating}
          label={`${model.name} is ${enabled ? "enabled" : "disabled"}`}
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
              label={`${group.name} ${granted ? "can use" : "cannot use"} ${model.name}`}
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
          Delete
        </button>
      </td>
    </tr>
  );
}

export function RuntimeProgress({ action }: { action: ModelRuntimeAction }) {
  const label = action === "loading" ? "Loading…" : "Unloading…";

  return (
    <span className="runtime-progress" role="status" aria-live="polite">
      <span className="runtime-progress-label">{label}</span>
      <span className="runtime-progress-track" aria-hidden="true">
        <span />
      </span>
    </span>
  );
}

export function PullProgress({ job }: { job?: ModelPullJob }) {
  const percentage = getPullPercentage(job);
  const label = job ? `${job.model}: ${job.message}` : "Starting pull…";
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

function isGroupGranted(policy: ModelAccessPolicy | undefined, groupId: string): boolean {
  return (
    policy?.grants.some((grant) => grant.canUse && grant.subject.type === "group" && grant.subject.id === groupId) ?? false
  );
}
