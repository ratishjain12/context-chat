import { MODELS, findModel, isWorkersAIModel, type ModelOption } from "./models.js";

// Documents are text-extracted before they reach a model, so images are the
// only input that constrains which models can answer.
export interface ModelNeeds {
  vision: boolean;
}

export function meetsNeeds(model: ModelOption, needs: ModelNeeds): boolean {
  return !needs.vision || model.vision;
}

function blendedPrice(model: ModelOption): number | null {
  if (model.pricePerMInput == null || model.pricePerMOutput == null) {
    return null;
  }
  return model.pricePerMInput + model.pricePerMOutput;
}

// Log scale: $0.30 -> $0.60 is as big a jump as $3 -> $6.
function priceDistance(a: ModelOption, b: ModelOption): number {
  const pa = blendedPrice(a);
  const pb = blendedPrice(b);
  if (pa == null || pb == null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(Math.log(pa) - Math.log(pb));
}

// Every other model that can serve `needs`, closest to the requested one
// first: same provider, then nearest price. A Workers AI pick only ranks
// Workers AI models, so a free-tier choice never turns into a paid provider
// call. Drives both the picker's auto-switch and the Worker's fallback chain.
export function rankAlternatives(requestedId: string, needs: ModelNeeds): ModelOption[] {
  const requested = findModel(requestedId);
  const workersAIOnly = isWorkersAIModel(requestedId);

  return MODELS.filter(
    (m) => m.id !== requestedId && meetsNeeds(m, needs) && (!workersAIOnly || isWorkersAIModel(m.id))
  ).sort((a, b) => {
    if (!requested) {
      return 0;
    }
    const sameProvider =
      Number(b.provider === requested.provider) - Number(a.provider === requested.provider);
    return sameProvider || priceDistance(a, requested) - priceDistance(b, requested);
  });
}

// The model that will actually be used for `preferredId` given `needs`:
// itself when capable, otherwise the closest capable alternative.
export function resolveModel(preferredId: string, needs: ModelNeeds): string {
  const preferred = findModel(preferredId);
  if (preferred && meetsNeeds(preferred, needs)) {
    return preferredId;
  }
  return rankAlternatives(preferredId, needs)[0]?.id ?? preferredId;
}
