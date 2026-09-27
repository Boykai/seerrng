import type {
  AssociationEdge,
  AssociationGraph,
} from '@app/hooks/useAssociations';
import { mapWithConcurrency } from '@app/utils/concurrency';
import axios from 'axios';

export const fetchCollectionAssociations = async (
  parts: { id: string | number }[],
  mediaType: 'movie' | 'tv' | 'album' | 'book'
): Promise<AssociationEdge[]> => {
  const collectionIds = new Set(parts.map((part) => String(part.id)));
  const results = await mapWithConcurrency(parts, 5, async (part) => {
    try {
      return (
        await axios.get<AssociationGraph>(
          `/api/v1/association/${mediaType}/${encodeURIComponent(String(part.id))}?includeWeak=true`
        )
      ).data.edges;
    } catch {
      return [];
    }
  });
  const unique = new Map<string, AssociationEdge>();
  results.flat().forEach((edge) => {
    const nodeId = String(edge.node.id);
    if (edge.node.mediaType === mediaType && collectionIds.has(nodeId)) return;
    const key = `${edge.node.mediaType}-${nodeId}`;
    if (!unique.has(key) || (unique.get(key)?.weight ?? 0) < edge.weight)
      unique.set(key, edge);
  });
  return [...unique.values()].sort((a, b) => b.weight - a.weight);
};
