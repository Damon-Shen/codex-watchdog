const STATUS_URL = "https://status.input.im/api/status";

export default function createAiInputPlugin({ config, host }) {
  return {
    apiVersion: 1,
    id: "aiinput",

    async checkModel({ signal }) {
      const response = await host.http.request({ url: STATUS_URL, signal });
      if (!response.ok) {
        throw new Error(`ai.input.im status request failed: HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload.services)) {
        throw new Error("ai.input.im response must contain a services array");
      }

      const service = payload.services.find(
        (entry) =>
          entry && typeof entry === "object" && entry.model === config.model,
      );
      if (!service) {
        throw new Error(`ai.input.im response contains no model ${config.model}`);
      }

      const status = service.last?.ok;
      if (typeof status !== "boolean") {
        throw new Error("ai.input.im model must have a boolean status");
      }

      return status;
    },
  };
}
