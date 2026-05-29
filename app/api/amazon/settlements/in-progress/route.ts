import { NextResponse } from 'next/server';
import { spApiCall, spApiErrorResponse } from '@/lib/sp-api/client';

/**
 * GET /api/amazon/settlements/in-progress
 *
 * Détecte le settlement Amazon **en cours d'accumulation** + le **prochain
 * dépôt prévu**, via SP-API Finances v0 `listFinancialEventGroups`.
 *
 * Différence vs `/api/amazon/settlements` (qui liste les TSV déjà clôturés
 * et déposés) :
 *   • Open      = cycle bi-hebdo en train d'être rempli (ventes en train
 *                 d'être agrégées). Pas encore de fund-transfer-date.
 *   • Closed    = clôturé MAIS pas encore le TSV final disponible
 *                 (window de quelques heures).
 *
 * Amazon publie les dates RÉELLES de période (BeginningBalance/End) telles
 * qu'affichées dans Seller Central → Statement view. Ce sont les mêmes
 * dates que celles d'un settlement clôturé.
 *
 * Returns { ok, open: {...} | null, recently_closed: [{...}] }
 */

export const dynamic = 'force-dynamic';

interface FinancialEventGroup {
  FinancialEventGroupId: string;
  ProcessingStatus?: 'Open' | 'Closed';
  FundTransferStatus?: string;
  OriginalTotal?: { CurrencyAmount: number; CurrencyCode: string };
  ConvertedTotal?: { CurrencyAmount: number; CurrencyCode: string };
  FundTransferDate?: string;
  TraceId?: string;
  AccountTail?: string;
  BeginningBalance?: { CurrencyAmount: number; CurrencyCode: string };
  FinancialEventGroupStart?: string;
  FinancialEventGroupEnd?: string;
  MarketplaceName?: string;
}

interface ListFinancialEventGroupsResponse {
  payload?: {
    FinancialEventGroupList?: FinancialEventGroup[];
    NextToken?: string;
  };
}

export async function GET() {
  try {
    // Période de scan : 60 jours en arrière suffit (cycles bi-hebdo).
    // On utilise FinancialEventGroupStartedAfter — Amazon répond avec
    // les groupes (Open + Closed) chevauchant la fenêtre.
    const startedAfter = new Date(Date.now() - 60 * 86_400_000).toISOString();

    const resp = await spApiCall<ListFinancialEventGroupsResponse>({
      method: 'GET',
      path: '/finances/v0/financialEventGroups',
      query: {
        FinancialEventGroupStartedAfter: startedAfter,
        MaxResultsPerPage: 25,
      },
    });

    const groups = resp.payload?.FinancialEventGroupList ?? [];

    // Sort: plus récent d'abord (par FinancialEventGroupStart).
    groups.sort((a, b) => {
      const da = a.FinancialEventGroupStart || '';
      const db = b.FinancialEventGroupStart || '';
      return db.localeCompare(da);
    });

    const open = groups.find((g) => g.ProcessingStatus === 'Open') ?? null;
    const closed = groups.filter((g) => g.ProcessingStatus === 'Closed');

    // Pour le settlement en cours, on dérive aussi la "prochaine date
    // probable de dépôt" : start + ~14 jours + 1-2 jours de banque.
    let projected_deposit: string | null = null;
    if (open?.FinancialEventGroupStart) {
      const start = new Date(open.FinancialEventGroupStart);
      // Amazon publie le TSV 1-2 jours après FinancialEventGroupEnd ;
      // pour un cycle bi-hebdo "start + 14j + 2j banque".
      projected_deposit = new Date(start.getTime() + 16 * 86_400_000).toISOString();
    }

    return NextResponse.json({
      ok: true,
      open: open
        ? {
            financial_event_group_id: open.FinancialEventGroupId,
            processing_status: open.ProcessingStatus,
            fund_transfer_status: open.FundTransferStatus ?? null,
            period_start: open.FinancialEventGroupStart ?? null,
            period_end: open.FinancialEventGroupEnd ?? null,
            beginning_balance:
              open.BeginningBalance?.CurrencyAmount ?? null,
            currency:
              open.OriginalTotal?.CurrencyCode ??
              open.BeginningBalance?.CurrencyCode ??
              null,
            original_total: open.OriginalTotal?.CurrencyAmount ?? null,
            converted_total: open.ConvertedTotal?.CurrencyAmount ?? null,
            fund_transfer_date: open.FundTransferDate ?? null,
            projected_deposit_date: projected_deposit,
            marketplace: open.MarketplaceName ?? null,
            account_tail: open.AccountTail ?? null,
          }
        : null,
      recently_closed: closed.slice(0, 5).map((g) => ({
        financial_event_group_id: g.FinancialEventGroupId,
        processing_status: g.ProcessingStatus,
        fund_transfer_status: g.FundTransferStatus ?? null,
        period_start: g.FinancialEventGroupStart ?? null,
        period_end: g.FinancialEventGroupEnd ?? null,
        original_total: g.OriginalTotal?.CurrencyAmount ?? null,
        currency: g.OriginalTotal?.CurrencyCode ?? null,
        fund_transfer_date: g.FundTransferDate ?? null,
        marketplace: g.MarketplaceName ?? null,
      })),
    });
  } catch (err) {
    const { body, status } = spApiErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
