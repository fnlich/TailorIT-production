'use client';

import { constantSpec, type AdminConstantList, type ConstantKey } from '@tailorit/shared/constants';
import type { ReviewLane } from '@tailorit/shared/reviews';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { userMessage } from '@/lib/api';
import { adminKeys, fetchAdminConstants, setAdminConstant } from '../api';
import { AUTO_APPROVE_KEYS, autoApproveRule, type AutoApproveKey } from './copy';

// v30 X1-WEB: the auto-approve strip (14 §6.2, §7): one switch per kind of review, each with its one-line rule. Each
// switch writes its constant (EXT_AUTO_APPROVE_*, off by default) through the Admin › Constants API, so Admin ›
// Constants and this strip show one value. The rule's number is its guard constant's value.

/** A row of GET /api/admin/constants. */
type ConstantItem = AdminConstantList['items'][number];

/** A guard constant's value from the list, else its default (while the list loads). */
const numberOf = (rows: readonly ConstantItem[] | undefined, key: ConstantKey): number => {
  const value = rows?.find((row) => row.key === key)?.value ?? constantSpec(key).default;
  return typeof value === 'number' ? value : 0;
};

export function AutoApproveStrip({ lane }: { lane: ReviewLane }) {
  const keys = AUTO_APPROVE_KEYS[lane] as readonly AutoApproveKey[];
  const constants = useQuery({ queryKey: adminKeys.constants, queryFn: ({ signal }) => fetchAdminConstants(signal), enabled: keys.length > 0 });
  if (keys.length === 0) return null;
  const rows = constants.data?.items;
  const numbers = {
    minReporters: numberOf(rows, 'EXT_AUTO_CLOSE_MIN_REPORTERS'),
    minPageAccounts: numberOf(rows, 'EXT_AUTO_NEW_PAGE_MIN_ACCOUNTS'),
  };
  return (
    <div
      role="group"
      aria-label="Automatic approval"
      className="flex flex-col gap-3 border-b border-border bg-surface-low px-4 py-3 sm:px-5 lg:flex-row lg:flex-wrap lg:gap-x-8"
      data-auto-approve=""
    >
      {keys.map((key) => {
        const row = rows?.find((item) => item.key === key);
        return row ? (
          <AutoSwitch key={key} row={row} rule={autoApproveRule(key, numbers)} />
        ) : constants.isError ? (
          <p key={key} className="text-[13px] text-muted-foreground">
            The automatic approval switches could not be loaded. {userMessage(constants.error)}
          </p>
        ) : (
          <Skeleton key={key} className="h-9 w-72" />
        );
      })}
    </div>
  );
}

function AutoSwitch({ row, rule }: { row: ConstantItem; rule: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const ruleId = useId();
  const change = useMutation({
    mutationFn: (on: boolean) => setAdminConstant(row.key, on),
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminConstantList>(adminKeys.constants, (list) =>
        list ? { ...list, items: list.items.map((item) => (item.key === updated.key ? updated : item)) } : list,
      );
      void queryClient.invalidateQueries({ queryKey: adminKeys.constants });
      toast.success(updated.value === true ? 'Automatic approval is on' : 'Automatic approval is off', updated.label);
    },
    onError: (error) => toast.error('The switch was not changed', userMessage(error)),
  });
  const checked = change.isPending ? Boolean(change.variables) : row.value === true;
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-auto-switch={row.key}>
      <Switch
        checked={checked}
        disabled={change.isPending}
        onCheckedChange={(on) => change.mutate(on)}
        label={<span className="font-medium">{row.label}</span>}
        aria-describedby={ruleId}
        className="min-h-11 sm:min-h-6"
      />
      {/* Under the label: past the switch's 36 px and its 10 px gap. */}
      <p id={ruleId} className="pl-[46px] text-[13px] leading-5 text-muted-foreground">
        {rule}
      </p>
    </div>
  );
}
