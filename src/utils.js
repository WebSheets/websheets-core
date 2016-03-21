export function parseNumMaybe(value) {
    if (value === true) {
        return 1;
    } else if (value === false) {
        return 0;
    }
    var parsed = parseFloat(value);
    return isNaN(parsed) ? value : parsed;
};
