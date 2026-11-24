// Métricas de roteamento. Funções puras, determinísticas e sem dependências.
// - PGR (ponto único) e APGR (curva): inspiradas em routellm/evals/evaluate.py.
// - Fronteira de Pareto em (custo, qualidade): não dominados.
// - AIQ: inspirada em routerbench/evaluation/AIQ.py (envoltória convexa superior, área normalizada).

export interface CurvePoint {
	/** Fração de chamadas/tarefas roteadas ao modelo forte, em [0, 1]. */
	x: number;
	/** Taxa de aprovação (pass rate) em [0, 1]. */
	y: number;
}

export interface MetricResult {
	value: number | null;
	/** Motivo quando `value` é null (caso degenerado). Null quando há valor. */
	reason: string | null;
}

function undefinedResult(reason: string): MetricResult {
	return { value: null, reason };
}

/** Ganho de desempenho recuperado num único ponto: 0 = igual ao fraco, 1 = igual ao forte. */
export function pgr(rate: number, weak: number, strong: number): MetricResult {
	if (![rate, weak, strong].every(Number.isFinite)) return undefinedResult("valor não finito");
	const denominator = strong - weak;
	if (Math.abs(denominator) < 1e-12) return undefinedResult("forte e fraco com o mesmo desempenho");
	return { value: (rate - weak) / denominator, reason: null };
}

/** Regra do trapézio sobre pontos já ordenados por x. */
export function trapezoid(points: readonly CurvePoint[]): number {
	let area = 0;
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		if (a === undefined || b === undefined) continue;
		area += ((a.y + b.y) / 2) * (b.x - a.x);
	}
	return area;
}

/**
 * APGR = (AUC_roteador - AUC_fraco) / (AUC_forte - AUC_fraco), com AUC pela regra do trapézio.
 * Fraco e forte são constantes no mesmo domínio x do roteador (convenção do routellm): AUC_fraco = w * Δx.
 * Denominadores degenerados (Δx = 0 ou forte = fraco) devolvem null com motivo, nunca NaN ou Infinity.
 */
export function apgr(curve: readonly CurvePoint[], weak: number, strong: number): MetricResult {
	if (![weak, strong].every(Number.isFinite)) return undefinedResult("valor não finito");
	if (curve.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return undefinedResult("ponto não finito");
	if (curve.length < 2) return undefinedResult("curva com menos de 2 pontos");
	const sorted = [...curve].sort((a, b) => a.x - b.x || a.y - b.y);
	const span = (sorted.at(-1)?.x ?? 0) - (sorted[0]?.x ?? 0);
	if (span <= 0) return undefinedResult("curva sem variação em x");
	const denominator = (strong - weak) * span;
	if (Math.abs(denominator) < 1e-12) return undefinedResult("forte e fraco com o mesmo desempenho");
	const aucRouter = trapezoid(sorted);
	const aucWeak = weak * span;
	return { value: (aucRouter - aucWeak) / denominator, reason: null };
}

export interface CostQualityPoint {
	id: string;
	/** Custo (USD quando há preço; tokens quando a telemetria é de assinatura). */
	cost: number;
	/** Taxa de aprovação em [0, 1]. */
	quality: number;
}

/** B domina A quando custa no máximo o mesmo, tem qualidade no mínimo igual, e é estritamente melhor em algum dos dois. */
function dominates(b: CostQualityPoint, a: CostQualityPoint): boolean {
	return b.cost <= a.cost && b.quality >= a.quality && (b.cost < a.cost || b.quality > a.quality);
}

/** Pontos não dominados, ordenados por custo crescente e, em empate, por qualidade decrescente. */
export function paretoFrontier(points: readonly CostQualityPoint[]): CostQualityPoint[] {
	const frontier = points.filter((p) => !points.some((q) => q !== p && dominates(q, p)));
	return frontier.sort((a, b) => a.cost - b.cost || b.quality - a.quality || a.id.localeCompare(b.id));
}

/** Envoltória convexa superior (concava de cima): a fronteira alcançável por mistura de pontos. */
function upperHull(points: readonly CurvePoint[]): CurvePoint[] {
	const hull: CurvePoint[] = [];
	for (const p of points) {
		while (hull.length >= 2) {
			const a = hull[hull.length - 2];
			const b = hull[hull.length - 1];
			if (a === undefined || b === undefined) break;
			const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
			if (cross >= 0) hull.pop();
			else break;
		}
		hull.push(p);
	}
	return hull;
}

/**
 * AIQ: área sob a envoltória convexa superior de (custo, qualidade), normalizada por xMax (convenção do routerbench).
 * A integração começa no menor custo do conjunto. A curva é estendida horizontalmente até xMax (padrão: maior custo).
 * Pontos fora da fronteira de Pareto não contribuem. Para comparar sistemas, passe o mesmo xMax a todos.
 */
export function aiq(points: readonly CostQualityPoint[], xMax?: number): MetricResult {
	if (points.length === 0) return undefinedResult("sem pontos");
	if (points.some((p) => !Number.isFinite(p.cost) || !Number.isFinite(p.quality)))
		return undefinedResult("ponto não finito");
	const maxCost = Math.max(...points.map((p) => p.cost));
	const limit = xMax ?? maxCost;
	if (limit < maxCost) return undefinedResult("xMax menor que o maior custo");
	if (limit <= 0) return undefinedResult("xMax não positivo");
	const frontier: CurvePoint[] = paretoFrontier(points).map((p) => ({ x: p.cost, y: p.quality }));
	const hull = upperHull(frontier);
	const last = hull.at(-1);
	if (last === undefined) return undefinedResult("sem pontos");
	const extended = last.x < limit ? [...hull, { x: limit, y: last.y }] : hull;
	return { value: trapezoid(extended) / limit, reason: null };
}
