import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
settings = json.loads((ROOT / 'configs/memory-v2.json').read_text(encoding='utf-8-sig'))
MODEL_DIR = str(ROOT / 'runtime/memory/models')
EMBED_MODEL_ID = settings['embedding_path']
RERANK_MODEL_ID = settings['reranker_path']
DEVICE = settings.get('device', 'cpu')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
