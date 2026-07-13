export function normalizeResidencyPolicy(value, fallbackServiceId = '') {
  return {
    serviceId: String(value?.serviceId || value?.service_id || value?.id || fallbackServiceId),
    resident: value?.resident === true,
    suspendedByUser: value?.suspendedByUser === true || value?.suspended_by_user === true,
    registered: value?.registered !== false,
    updatedAt: value?.updatedAt || value?.updated_at || null,
    lastError: value?.lastError || value?.last_error || null,
  };
}

export function residencyPresentation(value, fallbackServiceId = '') {
  const policy = normalizeResidencyPolicy(value, fallbackServiceId);
  if (!policy.resident) return { ...policy, label: '按需', tone: 'on-demand' };
  if (policy.suspendedByUser) return { ...policy, label: '常驻已暂停', tone: 'suspended' };
  if (policy.lastError) return { ...policy, label: '常驻异常', tone: 'failed' };
  return { ...policy, label: '常驻', tone: 'resident' };
}
