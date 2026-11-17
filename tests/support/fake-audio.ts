/** A node that only remembers what it was connected to. */
export class FakeAudioNode {
    connections: unknown[] = [];
    fftSize = 0;
    smoothingTimeConstant = 0.8;
    /** What getFloatTimeDomainData fills every sample with. */
    level = 0.5;
    /** What getByteFrequencyData copies, padded with 0. */
    bins = new Uint8Array(0);

    get frequencyBinCount(): number {
        return this.fftSize / 2;
    }

    connect(target: unknown): unknown {
        this.connections.push(target);

        return target;
    }

    disconnect(): void {
        this.connections = [];
    }

    getFloatTimeDomainData(buffer: Float32Array): void {
        buffer.fill(this.level);
    }

    getByteFrequencyData(array: Uint8Array): void {
        array.fill(0);
        array.set(this.bins.subarray(0, array.length));
    }
}

/** The AudioContext members the graph uses, recording each stream it was given. */
export function fakeAudioContext(
    options: {
        state?: AudioContextState;
        /** resume() never settles, as in Firefox with no audio output device. */
        stuck?: boolean;
    } = {},
) {
    const sources: MediaStream[] = [];
    /** Every analyser made, in order: the microphone's first, then the interviewer's. */
    const analysers: FakeAudioNode[] = [];
    let destinations = 0;
    /** The stereo destination's track: what a camera run records when the mix is live. */
    const mixTrack = {
        kind: 'audio',
        id: 'mix',
    } as unknown as MediaStreamTrack;
    const context = {
        state: options.state ?? ('running' as AudioContextState),
        sampleRate: 48_000,
        createAnalyser: () => {
            const node = new FakeAudioNode();
            analysers.push(node);

            return node;
        },
        createChannelMerger: () => new FakeAudioNode(),
        createGain: () => new FakeAudioNode(),
        createMediaStreamDestination: () => {
            destinations += 1;
            const own = {
                kind: 'audio',
                id: `destination-${destinations}`,
            } as unknown as MediaStreamTrack;
            const node = Object.assign(new FakeAudioNode(), {
                channelCount: 0,
                channelCountMode: 'max',
                stream: {
                    // Read lazily: the graph sets channelCount after it makes the node.
                    getAudioTracks: () => [
                        node.channelCount === 2 ? mixTrack : own,
                    ],
                },
            });

            return node;
        },
        createMediaStreamSource: (stream: MediaStream) => {
            sources.push(stream);

            return new FakeAudioNode();
        },
        resume: (): Promise<void> =>
            options.stuck === true ? new Promise(() => {}) : Promise.resolve(),
        close: async () => {
            context.state = 'closed';
        },
    };

    return {
        context: context as unknown as AudioContext,
        sources,
        mixTrack,
        analysers,
    };
}
