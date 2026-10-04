import { PageHeader } from '@acl/ui'
import { createFileRoute } from '@tanstack/react-router'
import { ApprovalRecords } from '#/components/approval-records.tsx'

export const Route = createFileRoute('/_app/approvals')({
  component: ApprovalsPage,
})

function ApprovalsPage() {
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Requests a guardrail paused for a human decision, and the decisions already made."
        details="A guardrail that ends in Approval holds the request until an admin approves or declines it here. A request that is not decided before its timer runs out expires and is declined. Approving a new device sign-in also trusts that device for future requests."
      />
      <div data-tour="approvals-list">
        <ApprovalRecords />
      </div>
    </>
  )
}
