export class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}

export class BreakSignal {}

export class ContinueSignal {}

export class ThrownSignal {
  constructor(value) {
    this.value = value;
  }
}
