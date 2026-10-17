"""Converts MediaPipe's hand landmarker models to the ONNX files in this
directory, which the Linux and Windows builds run through rten.

Reproduce from the repository root, in a fresh virtual environment:

    python3 -m venv /tmp/hand-models
    /tmp/hand-models/bin/pip install tensorflow-cpu==2.21.0 tf2onnx==1.17.0 \
        onnx==1.23.2 onnxruntime==1.31.0 ai-edge-litert==2.3.0 numpy==2.5.4
    /tmp/hand-models/bin/python src-tauri/models/convert.py

Reruns give the same graph and weights, but tf2onnx names some folded
constants differently each time, so the bytes are not reproducible. Weights
are stored as float16 behind Cast nodes: the source models hold float16
weights, so this is lossless and halves the files. The script refuses to
write a model whose outputs drift from the original TFLite model.
"""

import hashlib
import io
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime
from ai_edge_litert.interpreter import Interpreter
from onnx import TensorProto, helper, numpy_helper

TASK_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
TASK_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
MODELS = ("hand_detector", "hand_landmarks_detector")
OUT_DIR = Path(__file__).resolve().parent
MAX_RELATIVE_DRIFT = 1e-4


def fetch_task() -> bytes:
    with urllib.request.urlopen(TASK_URL) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != TASK_SHA256:
        sys.exit(f"hand_landmarker.task has sha256 {digest}, expected {TASK_SHA256}")
    return data


def store_weights_as_float16(model: onnx.ModelProto) -> None:
    """Rewrites each float32 initializer that is exactly representable in
    float16 as a float16 initializer plus a Cast back to float32."""
    casts = []
    for initializer in model.graph.initializer:
        if initializer.data_type != TensorProto.FLOAT:
            continue
        values = numpy_helper.to_array(initializer)
        half = values.astype(np.float16)
        if not np.array_equal(half.astype(np.float32), values):
            continue
        name = initializer.name
        initializer.CopyFrom(numpy_helper.from_array(half, f"{name}_f16"))
        casts.append(
            helper.make_node("Cast", [f"{name}_f16"], [name], to=TensorProto.FLOAT)
        )
    nodes = casts + list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend(nodes)


def check_parity(tflite_path: Path, onnx_bytes: bytes) -> float:
    """Largest output difference relative to the output's magnitude, over
    random inputs, between the TFLite model and the converted one."""
    interpreter = Interpreter(model_path=str(tflite_path), num_threads=1)
    interpreter.allocate_tensors()
    tflite_input = interpreter.get_input_details()[0]
    session = onnxruntime.InferenceSession(
        onnx_bytes, providers=["CPUExecutionProvider"]
    )
    onnx_input = session.get_inputs()[0].name
    output_names = [output.name for output in session.get_outputs()]
    rng = np.random.default_rng(0)
    worst = 0.0
    for _ in range(10):
        x = rng.random(tflite_input["shape"], dtype=np.float32)
        interpreter.set_tensor(tflite_input["index"], x)
        interpreter.invoke()
        converted = dict(zip(output_names, session.run(None, {onnx_input: x})))
        for detail in interpreter.get_output_details():
            expected = interpreter.get_tensor(detail["index"])
            actual = converted[detail["name"]]
            scale = float(np.max(np.abs(expected))) or 1.0
            worst = max(worst, float(np.max(np.abs(expected - actual))) / scale)
    return worst


def main() -> None:
    task = fetch_task()
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        with zipfile.ZipFile(io.BytesIO(task)) as bundle:
            bundle.extractall(work)
        for name in MODELS:
            tflite_path = work / f"{name}.tflite"
            converted_path = work / f"{name}.onnx"
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "tf2onnx.convert",
                    "--tflite",
                    str(tflite_path),
                    "--output",
                    str(converted_path),
                    "--opset",
                    "17",
                ],
                check=True,
                capture_output=True,
            )
            model = onnx.load(converted_path)
            store_weights_as_float16(model)
            onnx.checker.check_model(model)
            data = model.SerializeToString()
            drift = check_parity(tflite_path, data)
            if drift > MAX_RELATIVE_DRIFT:
                sys.exit(f"{name}: outputs drift {drift:.2e} from the TFLite model")
            (OUT_DIR / f"{name}.onnx").write_bytes(data)
            print(f"{name}.onnx: {len(data)} bytes, drift {drift:.2e}")


if __name__ == "__main__":
    main()
