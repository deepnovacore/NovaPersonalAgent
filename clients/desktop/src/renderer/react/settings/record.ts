import { floatToPcm16 } from '../../audio.mjs';
export function voiceprintWav(samples, sampleRate) {
    const pcm = floatToPcm16(samples, sampleRate);
    if (pcm.length < 160000 || pcm.length > 960000)
        throw new Error('voiceprint_audio_invalid');
    const wav = new Uint8Array(44 + pcm.length), view = new DataView(wav.buffer);
    const text = (offset, value) => wav.set(new TextEncoder().encode(value), offset);
    text(0, 'RIFF');
    view.setUint32(4, wav.length - 8, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, pcm.length, true);
    wav.set(pcm, 44);
    return wav;
}
export async function record(signal: AbortSignal, progress: (seconds: number) => void) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    let context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined, processor: AudioWorkletNode | undefined, timer: any;
    try {
        signal.throwIfAborted();
        context = new AudioContext({ sampleRate: 16000 });
        await context.resume();
        await context.audioWorklet.addModule('nova://orb/capture-worklet.mjs');
        signal.throwIfAborted();
        source = context.createMediaStreamSource(stream);
        processor = new AudioWorkletNode(context, 'nova-capture');
        const chunks: Float32Array[] = [];
        let count = 0;
        const done = new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('voiceprint_cancelled'));
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => reject(new Error('voiceprint_audio_invalid')), 16000);
            processor!.port.onmessage = event => {
                const samples = event.data?.samples;
                if (!(samples instanceof Float32Array))
                    return;
                const remaining = Math.floor(context!.sampleRate * 12) - count;
                const chunk = samples.slice(0, Math.max(0, remaining));
                chunks.push(chunk);
                count += chunk.length;
                progress(Math.min(12, Math.floor(count / context!.sampleRate)));
                if (count >= context!.sampleRate * 12) {
                    signal.removeEventListener('abort', abort);
                    resolve();
                }
            };
        });
        source.connect(processor);
        processor.connect(context.destination);
        await done;
        const samples = new Float32Array(count);
        let offset = 0;
        for (const chunk of chunks) {
            samples.set(chunk, offset);
            offset += chunk.length;
        }
        return voiceprintWav(samples, context!.sampleRate);
    }
    finally {
        clearTimeout(timer);
        processor?.disconnect();
        source?.disconnect();
        stream.getTracks().forEach(track => track.stop());
        await context?.close().catch(() => { });
    }
}
