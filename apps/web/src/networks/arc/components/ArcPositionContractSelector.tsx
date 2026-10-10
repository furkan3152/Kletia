export function ArcPositionContractSelector({
  position,
  legacy,
  hasV2,
  onChange,
}: {
  position: "staking" | "lending" | "liquidity";
  legacy: boolean;
  hasV2: boolean;
  onChange: (legacy: boolean) => void;
}) {
  return (
    <div className="my-4 space-y-2 text-sm font-bold text-[#1A1A1A] dark:text-white">
      <label className="block">
        <span className="mb-2 block font-black uppercase">
          Existing {position} position
        </span>
        <select
          aria-label={`Existing ${position} position contract`}
          value={legacy ? "legacy" : "v2"}
          disabled={!hasV2}
          onChange={(event) => onChange(event.target.value === "legacy")}
          className="w-full border-[3px] border-[#1A1A1A] bg-white p-3 dark:border-[#4B5563] dark:bg-[#0F172A]"
        >
          {hasV2 && <option value="v2">Upgraded contract (V2)</option>}
          <option value="legacy">Legacy contract (original position)</option>
        </select>
      </label>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Exits use the selected contract. Legacy positions stay in their original
        deployment; choosing V2 does not migrate them.
      </p>
    </div>
  );
}
