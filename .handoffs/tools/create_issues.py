import json, os, re, subprocess, sys, time

REPO = "martin-mael/ondes-v2"
OWNER = "martin-mael"
PROJECT_NUM = "1"
PROJECT_ID = "PVT_kwHOB3dX7c4Bnz5b"
FIELDS = {
    "Status": ("PVTSSF_lAHOB3dX7c4Bnz5bzhmWzSw", {"Backlog": "f75ad846"}),
    "Priority": ("PVTSSF_lAHOB3dX7c4Bnz5bzhmWzh8", {"P0": "79628723", "P1": "0a877460", "P2": "da944a9c"}),
    "Size": ("PVTSSF_lAHOB3dX7c4Bnz5bzhmWziA", {"XS": "911790be", "S": "b277fb01", "M": "86db8eb3", "L": "853c8207", "XL": "2d0801e2"}),
}
MILESTONES = {
    "M0 · Foundations & spikes": "Monorepo, data model, auth/RBAC, queues, storage, CI + engine de-risking spikes.",
    "M1 · Library & engine": "Media library with analysis, Liquidsoap engine per station, Icecast delivery, as-run, never-silent playout.",
    "M2 · Shows, clocks & log": "Music rotation and clocks, shows/episodes/live slots, log generation and timeline.",
    "M3 · Voice tracks & segue editor": "Linked and promo voice tracks, segue editor, island rendering.",
    "M4 · Live & events": "DJ identities, harbor pool, live slots, handover, automatic recording.",
    "M5 · Dashboard & public surface": "On-air dashboard, public API, widgets, webhooks, basic stats.",
    "M6 · Migration & go-live": "AzuraCast import, installer, backups, monitoring, Vandale cutover.",
    "Later": "Post-v1 backlog.",
}
LABEL_COLORS = {
    "type:spec": "0e8a16", "type:epic": "5319e7", "type:spike": "fbca04", "type:task": "c5def5",
}
AREA_COLOR = "bfd4f2"
STATE = os.path.join(os.path.dirname(__file__), "state.json")

def gh(*args, input=None):
    for attempt in range(5):
        r = subprocess.run(["gh", *args], capture_output=True, text=True, input=input)
        if r.returncode == 0:
            return r.stdout
        if "rate limit" in r.stderr.lower() or "secondary" in r.stderr.lower():
            time.sleep(30 * (attempt + 1)); continue
        raise RuntimeError(f"gh {' '.join(args[:4])}... failed: {r.stderr}")
    raise RuntimeError("rate limited")

def parse(path):
    items, cur = [], None
    for line in open(path, encoding="utf-8"):
        if line.startswith("@@ "):
            if cur: items.append(cur)
            kind, rest = line[3:].strip().split(" ", 1)
            parts = [p.strip() for p in rest.split("|")]
            if kind == "EPIC":
                key, title, ms, labels, prio, size = parts; parent = None
            else:
                parent, key, title, ms, labels, prio, size = parts
            cur = dict(kind=kind, key=key, parent=parent, title=title, milestone=ms,
                       labels=[l.strip() for l in labels.split(",")], priority=prio, size=size, body="")
        elif cur is not None:
            cur["body"] += line
    if cur: items.append(cur)
    for it in items: it["body"] = it["body"].strip() + "\n"
    return items

def project_item_id(num):
    q = 'query($n:Int!){ repository(owner:"martin-mael", name:"ondes-v2"){ issue(number:$n){ projectItems(first:10){ nodes{ id project{ id } } } } } }'
    for _ in range(10):
        data = json.loads(gh("api", "graphql", "-f", f"query={q}", "-F", f"n={num}"))
        for n in data["data"]["repository"]["issue"]["projectItems"]["nodes"]:
            if n["project"]["id"] == PROJECT_ID:
                return n["id"]
        try:
            return json.loads(gh("project", "item-add", PROJECT_NUM, "--owner", OWNER, "--url", f"https://github.com/{REPO}/issues/{num}", "--format", "json"))["id"]
        except RuntimeError as e:
            if "already exists" not in str(e): raise
            time.sleep(2)
    raise RuntimeError(f"no project item for #{num}")

def set_fields(it, num, url):
    item_id = project_item_id(num)
    for fname, val in (("Status", "Backlog"), ("Priority", it["priority"]), ("Size", it["size"])):
        fid, opts = FIELDS[fname]
        gh("project", "item-edit", "--id", item_id, "--project-id", PROJECT_ID,
           "--field-id", fid, "--single-select-option-id", opts[val])

def main():
    items = parse(sys.argv[1])
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    # labels
    existing = {l["name"] for l in json.loads(gh("label", "list", "-R", REPO, "--limit", "200", "--json", "name"))}
    for lab in sorted({l for it in items for l in it["labels"]}):
        if lab not in existing:
            gh("label", "create", lab, "-R", REPO, "--color", LABEL_COLORS.get(lab, AREA_COLOR))
    # milestones
    ms_existing = {m["title"] for m in json.loads(gh("api", f"repos/{REPO}/milestones?state=all&per_page=100"))}
    for t, d in MILESTONES.items():
        if t not in ms_existing:
            gh("api", f"repos/{REPO}/milestones", "-X", "POST", "-f", f"title={t}", "-f", f"description={d}")
    # issues
    for it in items:
        if it["key"] in state:
            if state[it["key"]].get("needs_fields"):
                set_fields(it, state[it["key"]]["number"], state[it["key"]]["url"])
                state[it["key"]].pop("needs_fields"); json.dump(state, open(STATE, "w"), indent=1)
            continue
        args = ["issue", "create", "-R", REPO, "--title", it["title"], "--body-file", "-", "--milestone", it["milestone"]]
        for l in it["labels"]: args += ["--label", l]
        url = gh(*args, input=it["body"]).strip().splitlines()[-1]
        num = int(url.rstrip("/").split("/")[-1])
        iid = json.loads(gh("api", f"repos/{REPO}/issues/{num}"))["id"]
        rec = {"url": url, "number": num, "id": iid}
        if it["parent"]:
            pnum = state[it["parent"]]["number"]
            gh("api", f"repos/{REPO}/issues/{pnum}/sub_issues", "-X", "POST", "-F", f"sub_issue_id={iid}")
        state[it["key"]] = dict(rec, needs_fields=True)
        json.dump(state, open(STATE, "w"), indent=1)
        set_fields(it, num, url)
        state[it["key"]] = rec
        json.dump(state, open(STATE, "w"), indent=1)
        print(f"#{num} {it['title']}", flush=True)
        time.sleep(1.5)

if __name__ == "__main__":
    main()
