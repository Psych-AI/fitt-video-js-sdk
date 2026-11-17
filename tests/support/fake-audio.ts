/** A node that only remembers what it was connected to. */
export class FakeAudioNode {
    connections: unknown[] = [];
    fftSize = 0;

    connect(target: unknown): unknown {
        this.connections.push(target);

        return target;
    }

    disconnect(): void {
        this.connections = [];
    }

    getFloatTimeDomainData(buffer: Float32Array): void {
        buffer.fill(0.5);
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
    /** The stereo destination's track: what a camera run records when the mix is live. */
    const mixTrack = {
        kind: 'audio',
        id: 'mix',
    } as unknown as MediaStreamTrack;
    const context = {
        state: options.state ?? ('running' as AudioContextState),
        createAnalyser: () => new FakeAudioNode(),
        createChannelMerger: () => new FakeAudioNode(),
        createGain: () => new FakeAudioNode(),
        createMediaStreamDestination: () =>
            Object.assign(new FakeAudioNode(), {
                channelCount: 0,
                channelCountMode: 'max',
                stream: { getAudioTracks: () => [mixTrack] },
            }),
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

    return { context: context as unknown as AudioContext, sources, mixTrack };
}
