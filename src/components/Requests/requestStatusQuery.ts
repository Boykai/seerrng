export type RequestStatusUserSelection = number | 'all' | null;

export const resolveRequestStatusUserSelection = ({
  canViewOtherUsers,
  queryUserId,
}: {
  canViewOtherUsers: boolean;
  queryUserId?: string;
}): RequestStatusUserSelection => {
  if (!canViewOtherUsers) {
    return null;
  }

  if (queryUserId && /^\d+$/.test(queryUserId)) {
    const userId = Number(queryUserId);
    return userId > 0 ? userId : 'all';
  }

  return 'all';
};

export const canLoadRequestStatus = ({
  currentUserId,
  canViewOtherUsers,
  selectedUser,
}: {
  currentUserId?: number;
  canViewOtherUsers: boolean;
  selectedUser: RequestStatusUserSelection;
}): boolean =>
  currentUserId !== undefined && (!canViewOtherUsers || selectedUser !== null);
