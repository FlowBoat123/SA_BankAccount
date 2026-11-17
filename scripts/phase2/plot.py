"""Plot measured medians and the full p95 range; never invent missing runs."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('--results', type=Path, default=Path('docs/performance/phase2/results'))
parser.add_argument('--title', default='SA BankAccount Phase 2')
args = parser.parse_args()
summary = json.loads((args.results / 'summary.json').read_text(encoding='utf-8'))
environment = json.loads((args.results / 'environment.json').read_text(encoding='utf-8'))
labels = {
    'transfer_hot_1': 'Transfer\nsame pair, 1 client',
    'transfer_hot_10': 'Transfer\nsame pair, 10 clients',
    'transfer_hot_50': 'Transfer\nsame pair, 50 clients',
    'transfer_distributed_10': 'Transfer\n10 separate pairs',
    'history_10000_deep': 'History\n10,000 rows',
    'history_300000_deep': 'History\n300,000 rows',
}
fig, axes = plt.subplots(2, 1, figsize=(11, 8), layout='constrained')
colors = {'baseline': '#6B7280', 'improved': '#167D8D'}
for axis, metric, title in zip(axes, ['p95', 'rps'], ['p95 latency (ms) — lower is better', 'Successful operations / second — higher is better']):
    for j, variant in enumerate(['baseline', 'improved']):
        xs = [i + (j - .5) * .34 for i in range(len(summary))]
        values = [row[variant][metric] for row in summary]
        errors = None
        if metric == 'p95':
            errors = [[row[variant]['p95'] - row[variant]['p95Min'] for row in summary],
                      [row[variant]['p95Max'] - row[variant]['p95'] for row in summary]]
        bars = axis.bar(xs, values, width=.32, color=colors[variant], label=variant.title(), yerr=errors, capsize=3)
        axis.bar_label(bars, fmt='%.1f', padding=3, fontsize=8)
    axis.set_xticks(range(len(summary)), [labels.get(row['scenario'], row['scenario']) for row in summary], fontsize=9)
    axis.set_title(title, loc='left', fontsize=12)
    axis.spines[['top', 'right']].set_visible(False)
    axis.grid(axis='y', alpha=.15)
    axis.set_axisbelow(True)
    axis.margins(y=.2)
axes[0].legend(frameon=False)
location = environment.get('location', 'Windows local')
seconds = environment.get('seconds', environment.get('duration'))
fig.suptitle(f'{args.title} | {location} | {environment["rounds"]} runs × {seconds}s', fontsize=14)
caption = 'Bars: median across runs. Error bars: min–max p95.'
if any(row['scenario'].startswith('history_') for row in summary):
    caption += ' History compares OFFSET + exact count with cursor browsing without count.'
else:
    caption += ' Transfer flow comparison; both versions use identical telemetry and schema.'
fig.text(.01, -.015, caption, fontsize=8)
fig.savefig(args.results / 'comparison.png', dpi=160, bbox_inches='tight')
fig.savefig(args.results / 'comparison.svg', bbox_inches='tight')
plt.close(fig)
