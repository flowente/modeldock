import type {
  AuditStore,
  Clock,
  ComponentHealth,
  DiagnosticCheck,
  DiagnosticCheckResult,
  DiagnosticStatus,
  OllamaGateway,
  TailscaleGateway
} from "@modeldock/core";
import { createComponentHealth } from "@modeldock/core";

export interface DiagnosticRegistry {
  list(): DiagnosticCheck[];
  run(checkId: string): Promise<DiagnosticCheckResult>;
  runAll(): Promise<DiagnosticCheckResult[]>;
}

export interface DiagnosticDependencies {
  clock: Clock;
  auditStore: AuditStore;
  ollama: OllamaGateway;
  tailscale: TailscaleGateway;
}

export function createDiagnosticRegistry(dependencies: DiagnosticDependencies): DiagnosticRegistry {
  const checks: DiagnosticCheck[] = [
    createHealthCheck("backend.health", "Backend health", dependencies.clock, () =>
      createComponentHealth({ name: "backend", status: "available", message: "Backend is running" }, dependencies.clock)
    ),
    createHealthCheck("storage.audit", "Audit storage", dependencies.clock, async () => {
      await dependencies.auditStore.append({
        actorId: "system",
        action: "DIAGNOSTIC_AUDIT_WRITE",
        module: "diagnostics",
        result: "success",
        correlationId: "diagnostic"
      });

      return createComponentHealth({ name: "storage", status: "available", message: "Audit storage is writable" }, dependencies.clock);
    }),
    createHealthCheck("ollama.connection", "Ollama connection", dependencies.clock, () => dependencies.ollama.getHealth()),
    createCheck("ollama.listModels", "Ollama model inventory", dependencies.clock, async () => {
      const models = await dependencies.ollama.listLocalModels();
      return {
        status: models.length > 0 ? "pass" : "warn",
        message: models.length > 0 ? `${models.length} model(s) available` : "No local models found",
        details: { count: models.length }
      };
    }),
    createHealthCheck("tailscale.status", "Tailscale status", dependencies.clock, () => dependencies.tailscale.getLocalStatus()),
    createCheck("tailscale.devices", "Tailscale devices", dependencies.clock, async () => {
      const devices = await dependencies.tailscale.listDevices();
      return {
        status: devices.length > 0 ? "pass" : "warn",
        message: devices.length > 0 ? `${devices.length} device(s) visible` : "No Tailscale devices found",
        details: { count: devices.length }
      };
    })
  ];

  return {
    list() {
      return checks;
    },
    async run(checkId: string) {
      const check = checks.find((item) => item.id === checkId);

      if (!check) {
        return {
          id: checkId,
          label: checkId,
          status: "fail",
          message: "Diagnostic check not found",
          durationMs: 0,
          timestamp: dependencies.clock.now().toISOString(),
          suggestion: "Refresh the page and try again."
        };
      }

      return check.run();
    },
    async runAll() {
      const results: DiagnosticCheckResult[] = [];

      for (const check of checks) {
        results.push(await check.run());
      }

      return results;
    }
  };
}

function createHealthCheck(
  id: string,
  label: string,
  clock: Clock,
  runHealth: () => Promise<ComponentHealth> | ComponentHealth
): DiagnosticCheck {
  return createCheck(id, label, clock, async () => {
    const health = await runHealth();
    return {
      status: mapHealthToDiagnostic(health.status),
      message: health.message,
      details: health.details
    };
  });
}

function createCheck(
  id: string,
  label: string,
  clock: Clock,
  runCheck: () => Promise<{ status: DiagnosticStatus; message: string; details?: Record<string, unknown>; suggestion?: string | null }>
): DiagnosticCheck {
  return {
    id,
    label,
    async run() {
      const started = clock.now().getTime();

      try {
        const result = await runCheck();
        return {
          id,
          label,
          status: result.status,
          message: result.message,
          durationMs: Math.max(0, clock.now().getTime() - started),
          timestamp: clock.now().toISOString(),
          details: result.details,
          suggestion: result.suggestion ?? null
        };
      } catch (error) {
        return {
          id,
          label,
          status: "fail",
          message: error instanceof Error ? error.message : "Diagnostic check failed",
          durationMs: Math.max(0, clock.now().getTime() - started),
          timestamp: clock.now().toISOString(),
          suggestion: "Open the technical details and check the related service."
        };
      }
    }
  };
}

function mapHealthToDiagnostic(status: ComponentHealth["status"]): DiagnosticStatus {
  if (status === "available") {
    return "pass";
  }

  if (status === "degraded" || status === "unknown" || status === "not_configured") {
    return "warn";
  }

  return "fail";
}

