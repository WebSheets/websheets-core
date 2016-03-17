import Emitter from './Emitter';
import {getCellID, getCellPos} from './cellID';
import parseExpression from './exprCompiler';
import {parseNumMaybe} from './exprCompiler/functions';


const defaultParams = {
    context: null,
    immutable: false,
    name: null,

    height: 6,
    width: 6,

    iterate: true,
    maxIterations: 1000,
    iterationEpsilon: 0.001,
};


const WINDOW_MOUSEUP = Symbol('window.onmouseup');

export default class WebSheet {
    constructor(params = {}) {
        Object.assign(this, defaultParams, params);

        this.data = [];
        this.calculated = [];

        this.calculationSemaphore = null;
        this.calculationSourceGraph = null;
        this.depUpdateQueue = null;
        this.dependencies = {}; // Map of cell ID to array of dependant cell IDs
        this.dependants = {}; // Map of cell ID to array of dependencies

        this.valueUpdates = new Emitter();
        this.calculatedUpdates = new Emitter();
        this.console = new Emitter();
    }

    addColumn(rerender = true) {
        this.width += 1;
        if (rerender) {
            this.forceRerender();
        }
    }
    addRow(rerender = true) {
        this.height += 1;
        this.data.push(new Array(this.width));
        this.calculated.push(new Array(this.width));
        if (rerender) {
            this.forceRerender();
        }
    }

    calculateValueAtPosition(row, col, expression) {
        if (!expression) return;
        const cellID = getCellID(row, col);
        let value;

        // Do some cycle detection.
        if (this.calculationSemaphore) {
            if (cellID in this.calculationSemaphore) {
                if (this.calculationSemaphore[cellID] > this.maxIterations) {
                    this.console.fire('warn', 'Circular reference hit max iteration limit');
                    return;
                }

                this.calculationSemaphore[cellID]++;

            } else {
                this.calculationSemaphore[cellID] = 1;
            }
        }

        // Parse the expression
        const parsed = parseExpression(expression);

        // Evaluate the expression to find a value
        try {
            value = parsed.run(this);
        } catch (e) {
            value = new Error('#ERROR!');
        }

        // Set the calculated value in the calculated cache
        this.calculated[row] = this.calculated[row] || [];

        const origCalculatedValue = this.calculated[row][col];
        const wasUpdated = (
            origCalculatedValue !== value ||
            Math.abs(origCalculatedValue - value) > this.iterationEpsilon
        );

        if (!wasUpdated) {
            return;
        }

        this.calculated[row][col] = value;

        // Set the dependants
        const dependants = [];
        if (parsed) {
            // Bind intra-sheet dependencies
            parsed.findCellDependencies(dep => {
                if (dependants.indexOf(dep) !== -1) return;
                dependants.push(dep);
                if (!(dep in this.dependencies)) {
                    this.dependencies[dep] = [cellID];
                    return;
                }

                const deps = this.dependencies[dep];
                if (deps && deps.indexOf(cellID) === -1) {
                    deps.push(cellID);
                }
            });

            // Bind inter-sheet dependencies if a sheet context exists
            if (this.context) {
                this.context.clearDependencies(this, cellID);
                let sheetDeps = [];
                parsed.findSheetDependencies((sheet, dep) => {
                    if (!this.context.sheets[sheet.toUpperCase()]) return;
                    var depName = `${sheet}!${dep}`;
                    if (sheetDeps.indexOf(depName) !== -1) return;
                    sheetDeps.push(depName);

                    this.context.setDependency(this, cellID, sheet, dep, () => {
                        this.calculateValueAtPosition(row, col, expression);
                    });

                });
            }

        }
        this.dependants[cellID] = dependants;

        this.updateDependencies(cellID);
        this.calculatedUpdates.fire(cellID, value);

        return this.formatValue(cellID, value);
    }

    forceRerender() {
        this.console.fire('log', 'Rerender ignored in headless websheet');
    }

    clearCell(row, col) {
        const cellID = getCellID(row, col);
        if (row in this.data) delete this.data[row][col];
        if (row in this.calculated) delete this.calculated[row][col];
        this.clearDependants(cellID);
        this.dependants[cellID] = [];
    }

    clearDependants(id) {
        const deps = this.dependants[id];
        if (!deps) return;

        for (let i = 0; i < deps.length; i++) {
            let remDeps = this.dependencies[deps[i]];
            if (!remDeps) continue;
            let idx = remDeps.indexOf(id);
            if (idx !== -1) remDeps.splice(idx, 1);
        }

        if (!this.context) return;
        this.context.clearDependencies(this, id);
    }

    formatValue(cellID, value) {
        switch (typeof value) {
            case 'string':
                break; // pass

            case 'number':
                if (value === Infinity || value === -1 * Infinity) {
                    return '#DIV/0!';
                }
                if (isNaN(value)) {
                    return '#VALUE!';
                }
                value = value.toString();
                break;

            case 'boolean':
                value = value ? 'TRUE' : 'FALSE';
                break;

            default:
                if (value instanceof Date) {
                    value = value.toLocaleString();
                    break;
                }
                if (value instanceof Error) {
                    return value.message;
                }
                return '#VALUE!';
        }

        return value;
    }

    getCalculatedValueAtID(id) {
        const {row, col} = getCellPos(id);
        return this.getCalculatedValueAtPos(row, col);
    }

    getCalculatedValueAtPos(row, col) {
        if (row in this.calculated) {
            let data = this.calculated[row][col];
            if (data !== null && typeof data !== 'undefined') {
                return parseNumMaybe(data);
            }
        }
        if (row in this.data) {
            let data = this.data[row][col];
            if (data !== null && typeof data !== 'undefined') {
                return parseNumMaybe(data);
            }
        }

        return 0;
    }

    getSheet(name) {
        if (!this.context) {
            throw new Error('No context to extract sheet from');
        }
        name = name.toUpperCase();
        if (!(name in this.context.sheets)) {
            throw new Error('Undefined sheet requested');
        }
        return this.context.sheets[name];
    }

    getValueAtPos(row, col) {
        return (this.data[row] || [])[col] || null;
    }

    insertColumnBefore(idx) {
        this.width += 1;
        for (let i = 0; i < this.height; i++) {
            if (this.data[i]) {
                this.data[i].splice(idx, 0, null);
            }
            if (this.calculated[i]) {
                this.calculated[i].splice(idx, 0, null);
            }
        }
        this.forceRerender();
    }
    insertRowBefore(idx) {
        this.height += 1;
        this.data.splice(idx, 0, new Array(this.width));
        this.calculated.splice(idx, 0, new Array(this.width));
        this.forceRerender();
    }

    loadData(data) {
        while (this.height < data.length) this.addRow(false);
        while (this.width < data[0].length) this.addColumn(false);

        for (let i = 0; i < data.length; i++) {
            this.data[i] = this.data[i] || [];
            for (let j = 0; j < data[i].length; j++) {
                this.setValueAtPosition(i, j, data[i][j], true);
            }
        }
        this.forceRerender();
    }

    popColumn() {
        if (this.width < 2) throw new Error('Cannot make spreadsheet that small');
        this.width -= 1;
        for (let i = 0; i < this.height; i++) {
            if (this.data[i] && this.data[i].length > this.width) this.data[i].pop();
            if (this.calculated[i] && this.calculated[i].length > this.width) this.calculated[i].pop();
        }
        this.forceRerender();
    }
    popRow() {
        if (this.height < 2) throw new Error('Cannot make spreadsheet that small');
        this.height -= 1;
        this.data.pop();
        this.calculated.pop();
        this.forceRerender();
    }

    removeColumn(idx) {
        if (this.width < 2) throw new Error('Cannot make spreadsheet that small');
        if (idx < 0 || idx >= this.width) throw new Error('Removing cells that do not exist');

        this.width -= 1;
        for (let i = 0; i < this.height; i++) {
            if (this.data[i]) this.data[i].splice(idx, 1);
            if (this.calculated[i]) this.calculated[i].splice(idx, 1);
        }
        this.forceRerender();
    }
    removeRow(i) {
        if (this.height < 2) throw new Error('Cannot make spreadsheet that small');
        if (i < 0 || i >= this.width) throw new Error('Removing cells that do not exist');

        this.height -= 1;
        this.data.splice(i, 1);
        this.calculated.splice(i, 1);
        this.forceRerender();
    }

    setValueAtPosition(row, col, value, force = false) {
        const cellID = getCellID(row, col);

        this.data[row] = this.data[row] || [];
        if (this.data[row][col] === value && !force) {
            return false;
        }

        this.data[row][col] = value;
        if (this.calculated[row]) {
            delete this.calculated[row][col];
        }

        this.clearDependants(cellID);

        this.valueUpdates.fire(cellID, value);

        if (value[0] === '=') {
            this.calculateValueAtPosition(row, col, value.substr(1));
        } else {
            this.updateDependencies(cellID);
        }

        return true;
    }

    updateDependencies(cellID) {
        const deps = this.dependencies[cellID];
        if (!deps) {
            return;
        }

        if (this.depUpdateQueue) {
            // Iterate each dependency
            for (let dep of deps) {
                // Have we seen this dependency before?
                if (this.calculationSourceGraph) {
                    if (dep in this.calculationSourceGraph) {
                        // If we've seen it referenced from this source before and
                        // iteration is banned, report it.
                        if (!this.iterate &&
                            this.calculationSourceGraph[dep].indexOf(cellID) !== -1) {
                            this.console.fire('error', `Cyclic reference banned at ${cellID} -> ${dep}`);
                            continue;
                        }
                        // If we haven't seen it, mark that we've seen it
                        // referenced from this cell.
                        this.calculationSourceGraph[dep].push(cellID);
                    } else {
                        // If we haven't seen it, create the entry.
                        this.calculationSourceGraph[dep] = [cellID];
                    }
                }

                // If we've already queueued the recalculation of the
                // dependency, don't queue it a second time.
                if (this.depUpdateQueue.indexOf(dep) !== -1) {
                    continue;
                }
                // Otherwise queue the dependency for recalculation.
                this.depUpdateQueue.push(dep);
            }
            return;
        }

        if (!this.iterate) {
            this.calculationSourceGraph = {};
        }
        this.calculationSemaphore = {[cellID]: 1};
        this.depUpdateQueue = [...deps];

        while (this.depUpdateQueue.length) {
            const dep = this.depUpdateQueue.shift();
            const {row, col} = getCellPos(dep);
            this.calculateValueAtPosition(row, col, this.data[row][col].substr(1));
        }

        this.calculationSourceGraph = null;
        this.calculationSemaphore = null;
        this.depUpdateQueue = null;
    }
};
