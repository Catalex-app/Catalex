# GitHub issue search

Set `issue_repo` to the verified `issueRepository` from `.githubissues.json`. These commands query the task repository directly and do not use GitHub Projects. Search syntax and flags are documented in the [GitHub CLI issue list manual](https://cli.github.com/manual/gh_issue_list) and [GitHub issue filtering docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests).

## Selection queries

When the user specifies a target, add `--label "$target"` to every top-level selection query below, with `target` set to the exact requested label. Omit it otherwise; do not apply this filter when selecting children.

Use oldest-first results for each tier. Inspect `parent` and labels on the candidates. Increase the limit or page the query before concluding that a tier has no eligible issue; the CLI defaults to only 30 results.

```bash
# Active: inspect this tier first.
gh issue list -R "$issue_repo" --state open \
  --search 'no:parent-issue label:"in progress" -label:wontfix sort:created-asc' \
  --limit 100 --json number,title,createdAt,labels,parent

# Queued urgent; repeat with high and medium.
gh issue list -R "$issue_repo" --state open \
  --search 'no:parent-issue label:"priority: urgent" -label:"in progress" -label:wontfix sort:created-asc' \
  --limit 100 --json number,title,createdAt,labels,parent

# Queued normal: no priority label, but other labels are allowed.
gh issue list -R "$issue_repo" --state open \
  --search 'no:parent-issue -label:"in progress" -label:wontfix -label:"priority: urgent" -label:"priority: high" -label:"priority: medium" sort:created-asc' \
  --limit 100 --json number,title,createdAt,labels,parent
```

Do not use `--no-label` for normal priority: an issue with a `bug` or `enhancement` label can still be normal. For ad hoc text lookup, add search terms to `--search` or fetch a known issue by number. Use `no:parent-issue` in every automatic selection tier to include only top-level issues, including standalone tasks. After selecting a parent, rank only its direct children using the same active-first and priority ordering.

## Full details and children

```bash
gh issue view "$issue_number" -R "$issue_repo" \
  --json number,title,body,state,stateReason,labels,parent,subIssues,subIssuesSummary,comments,createdAt,url
```

For a parent, compare `subIssues.totalCount` (also `subIssuesSummary.total`) with the number of returned `subIssues.nodes`. If incomplete, page the native sub-issue endpoint rather than assuming the first page contains every child:

```bash
gh api --paginate "repos/$issue_repo/issues/$parent_number/sub_issues?per_page=100"
```

Use `gh issue create -R "$issue_repo" --parent "$parent_number" ...` to create a child, or `gh issue edit "$child_number" -R "$issue_repo" --parent "$parent_number"` to link an existing issue. Close issues only after the selected completion path succeeds. Before closing, remove only the `in progress` label; preserve priority, target, and other descriptive labels, then run `gh issue close "$issue_number" -R "$issue_repo" --reason completed`.
