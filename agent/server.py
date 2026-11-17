"""One service: the ADK agent API, the JSON the screen draws from, and the screen itself."""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

AGENT_DIR = Path(__file__).parent
load_dotenv(AGENT_DIR / "microgrants" / ".env")

from fastapi import HTTPException  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from google.adk.cli.fast_api import get_fast_api_app  # noqa: E402

from microgrants import analysis, closure, data, tools  # noqa: E402
from microgrants.applicants import APPLICANTS  # noqa: E402
from report import router as report_router  # noqa: E402
from uploads import router as uploads_router  # noqa: E402

app = get_fast_api_app(
    agents_dir=str(AGENT_DIR),
    web=True,
    auto_create_session=True,
    allow_origins=["*"],
)


app.include_router(uploads_router)
app.include_router(report_router)


@lru_cache(maxsize=1)
def _supply_edges() -> list[dict]:
    return data.rows(
        f"SELECT supplier_id AS source, buyer_id AS target, ROUND(intensity, 4) AS intensity "
        f"FROM `{data.PROJECT}.{data.DATASET}.supplies`"
    )


@app.get("/api/overview")
def overview() -> dict:
    return _overview()


@lru_cache(maxsize=1)
def _overview() -> dict:
    """Everything the screen needs at load: the queue, the plan and the evidence checks."""
    queue = tools.get_applicant_queue()
    ids = [a["business_id"] for a in APPLICANTS]
    plan = analysis.plan_budget()
    funded = [step["business_id"] for step in plan["plan"]]
    return {
        "fund": {"budget_usd": queue["budget_usd"], "total_requested_usd": queue["total_requested_usd"]},
        "applicants": tools.compare_applicants(ids)["applicants"],
        "plan": plan,
        "baseline": data.corridor_baseline(),
        "employer_blocks": closure.list_employer_blocks(8)["employer_blocks"],
        "health": analysis.data_health_check(),
        "audit": analysis.equity_audit(funded) if funded else None,
    }


@app.get("/api/config")
def config() -> dict:
    """Browser settings. The Maps key is restricted to this site's addresses and to the Maps API."""
    return {"maps_api_key": os.environ.get("MAPS_API_KEY", "")}


@app.get("/api/plan")
def plan(budget_usd: int = 0) -> dict:
    return analysis.plan_budget(budget_usd)


@app.get("/api/network")
def network() -> dict:
    queue = {a["business_id"] for a in APPLICANTS}
    nodes = [
        {
            "id": b["business_id"],
            "name": b["name"],
            "address": b["address"],
            "lat": b["latitude"],
            "lon": b["longitude"],
            "naics4": b["naics4"],
            "role": b["network_role"].split(" (")[0],
            "reach": b["total_exposed_2hop"],
            "peers": b["same_industry_peers"],
            "poverty": b["tract_poverty_rate"],
            "applicant": b["business_id"] in queue,
        }
        for b in data.directory().values()
    ]
    return {"nodes": nodes, "edges": _supply_edges()}


@app.get("/api/cascade/{business_id}")
def cascade(business_id: str, hops: int = 2) -> dict:
    result = tools.trace_cascade(business_id, hops)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    paths = data.walk(business_id, data.clamp_hops(hops), "downstream")
    exposed = data.best_paths(paths)
    return {
        **result,
        "exposed": [
            {"id": e["business_id"], "hops": e["hops"], "strength": e["path_strength"]}
            for e in exposed.values()
        ],
        "links": data.path_links(paths),
    }


@app.get("/api/closure/{block_id}")
def employer_closure(block_id: str, hops: int = 2) -> dict:
    result = _closure(block_id, data.clamp_hops(hops))
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@lru_cache(maxsize=64)
def _closure(block_id: str, hops: int) -> dict:
    result = closure.simulate_employer_closure(block_id, hops)
    return result if "error" in result else {**result, "map": closure.map_view(block_id, hops)}


@app.get("/api/scenarios/{business_id}")
def scenarios(business_id: str, grant_usd: int, compare_to: str = "") -> dict:
    result = analysis.grant_impact_scenarios(business_id, grant_usd, compare_to)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@app.get("/api/what-if")
def what_if(funded: str, fails: str) -> dict:
    result = analysis.what_if_fails_anyway(funded, fails)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


WEB_DIR = AGENT_DIR / "web"


def home() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


# Registered first so the relief desk, not the ADK developer UI, answers at the root.
# The ADK developer UI stays available at /dev-ui/.
app.router.add_api_route("/", home, methods=["GET"], include_in_schema=False)
app.router.routes.insert(0, app.router.routes.pop())
app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
